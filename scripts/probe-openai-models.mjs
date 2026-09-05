// Probe gpt-5 / gpt-5-mini against the REAL agent tool schemas, the same way
// every Groq model was probed before shipping (see CONVERSATION_SUMMARY.md,
// "MODEL SELECTION: probe BOTH halves of the agent loop"). A model must pass
// two independent tests here — passing one says nothing about the other:
//   1. Tool call   — emit valid tool-call JSON for the real schema
//   2. Post-tool   — produce visible `content` on the step after a tool result
//
// Hits the REAL OpenAI API and spends real (paid) tokens. Attempts are kept
// small (3, not the 5 used for free-tier Groq) to bound cost on a paid account.
import fs from "node:fs";

const root = new URL("..", import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, "");
const KEY = /OPENAI_API_KEY=(.+)/.exec(fs.readFileSync(root + "/.env.local", "utf8"))?.[1]?.trim();
if (!KEY) {
  console.error("OPENAI_API_KEY not found in .env.local");
  process.exit(1);
}

// Pulled live from route.ts so this never drifts from what's actually shipped.
const src = fs.readFileSync(root + "/app/api/agent/route.ts", "utf8");
const spStart = src.indexOf("const SYSTEM_PROMPT");
const o = src.indexOf("`", spStart);
const c = src.indexOf("`;", o + 1);
const SYSTEM_PROMPT = src.slice(o + 1, c);

// Mirrors the three tools in route.ts. All three are loose schemas in
// production (z.looseObject / raw JSON Schema with additionalProperties:
// true) — see "Tool schemas are LOOSE on purpose" in CONVERSATION_SUMMARY.md.
const TOOLS = [
  {
    type: "function",
    function: {
      name: "knowledge_base_search",
      description: "Search the internal knowledge base for facts about LangChain, Supabase, n8n, and CRMs. Accepts ONLY: query (required string). Example: {\"query\": \"pgvector\"}",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: true },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web for current or real-time information. Accepts ONLY these parameters: query (required, a search-terms string), maxResults (optional number), recencyDays (optional number). You cannot pass a URL or fetch a specific page — describe what you want in `query` instead. Example: {\"query\": \"latest LangChain version\"}",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search terms, e.g. 'latest LangChain version'. Required." },
          maxResults: { type: "integer", minimum: 1, maximum: 10, description: "How many results, default 3" },
          recencyDays: { type: "integer", minimum: 1, description: "Only results from the last N days" },
        },
        additionalProperties: true,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "calculator",
      description: "Evaluates a math expression using + - * / and parentheses. Accepts ONLY: expression (required string). Example: {\"expression\": \"34 * 0.15\"}",
      parameters: { type: "object", properties: { expression: { type: "string" } }, required: ["expression"], additionalProperties: true },
    },
  },
];

const MODELS = ["gpt-5", "gpt-5-mini"];
const ATTEMPTS = 3;
const Q = "Plan a 9-day Turkey itinerary covering Istanbul, Antalya, Cappadocia, and Fethiye";

async function chat(model, messages, { tools, maxTokens = 400, reasoningEffort } = {}) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      max_completion_tokens: maxTokens,
      messages,
      ...(tools ? { tools } : {}),
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    }),
  });
  const j = await r.json();
  if (!r.ok) {
    return { error: j.error ?? { message: `HTTP ${r.status}` } };
  }
  return { message: j.choices[0].message, finish_reason: j.choices[0].finish_reason, usage: j.usage };
}

function searchResult(remaining) {
  return JSON.stringify({
    answer: null,
    results: [
      { title: "Turkey 9-Day Tours", url: "https://example.com/aaaaaaaaaaaa", snippet: "x".repeat(150) },
      { title: "Cappadocia Guide", url: "https://example.com/bbbbbbbbbbbb", snippet: "x".repeat(150) },
    ],
    searchesRemaining: remaining,
    note: remaining === 0 ? "This was your last search. Answer now from what you have." : undefined,
  });
}

/**
 * Simulates the search budget fully spent (MAX_SEARCHES_PER_TURN=3 in
 * route.ts) — the actual state production guarantees before it expects an
 * answer. Testing after a SINGLE thin tool result (the first version of this
 * script did that) is not a fair test: with no "answer" field and generic
 * placeholder snippets, a model correctly following the system prompt's
 * "never repeat a search... note it and stop" rule may legitimately choose to
 * search again rather than fabricate specifics — that's not brokenness.
 */
function buildExhaustedBudgetMessages() {
  const msgs = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: Q },
  ];
  for (let n = 1; n <= 3; n++) {
    const id = `call_probe_${n}`;
    msgs.push({
      role: "assistant",
      content: null,
      tool_calls: [{ id, type: "function", function: { name: "web_search", arguments: JSON.stringify({ query: `Turkey itinerary search ${n}` }) } }],
    });
    msgs.push({ role: "tool", tool_call_id: id, content: searchResult(3 - n) });
  }
  return msgs;
}

async function probeModel(model) {
  const result = { model, toolCalls: 0, toolCallErrors: [], postToolContentLens: [], postToolFinish: [], rateLimitRaw: null };

  console.log(`\n=== ${model}: tool-call phase (${ATTEMPTS} attempts) ===`);
  for (let i = 0; i < ATTEMPTS; i++) {
    const res = await chat(model, [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: Q }], {
      tools: TOOLS,
      maxTokens: 1000, // reasoning models spend some of this budget on hidden reasoning tokens
    });
    if (res.error) {
      const msg = res.error.message ?? JSON.stringify(res.error);
      console.log(`  attempt ${i + 1}: ERROR ${msg.slice(0, 150)}`);
      result.toolCallErrors.push(msg);
      if (/rate.?limit|429|tokens per|requests per/i.test(msg)) result.rateLimitRaw = msg;
      continue;
    }
    const calls = res.message.tool_calls ?? [];
    if (calls.length === 0) {
      console.log(`  attempt ${i + 1}: NO TOOL CALL (finish=${res.finish_reason}, content="${(res.message.content ?? "").slice(0, 80)}")`);
      continue;
    }
    const call = calls[0];
    let argsOk = false;
    try {
      const parsed = JSON.parse(call.function.arguments);
      argsOk = typeof parsed.query === "string" && parsed.query.length > 0;
    } catch {
      argsOk = false;
    }
    console.log(`  attempt ${i + 1}: tool=${call.function.name} args=${call.function.arguments} valid=${argsOk}`);
    if (argsOk) result.toolCalls++;
  }

  console.log(`\n=== ${model}: post-tool completion phase, budget exhausted (${ATTEMPTS} attempts) ===`);
  for (let i = 0; i < ATTEMPTS; i++) {
    const res = await chat(model, buildExhaustedBudgetMessages(), { tools: TOOLS, maxTokens: 1500 });
    if (res.error) {
      const msg = res.error.message ?? JSON.stringify(res.error);
      console.log(`  attempt ${i + 1}: ERROR ${msg.slice(0, 150)}`);
      if (/rate.?limit|429|tokens per|requests per/i.test(msg)) result.rateLimitRaw = msg;
      continue;
    }
    const len = (res.message.content ?? "").length;
    const calledMoreTools = (res.message.tool_calls ?? []).length > 0;
    console.log(`  attempt ${i + 1}: finish=${res.finish_reason} content_len=${len} called_more_tools=${calledMoreTools} reasoning_tokens=${res.usage?.completion_tokens_details?.reasoning_tokens}`);
    result.postToolContentLens.push(len);
    result.postToolFinish.push(res.finish_reason);
  }

  console.log(`\n=== ${model}: post-tool completion phase, budget exhausted, reasoning_effort=minimal (${ATTEMPTS} attempts) ===`);
  result.lowEffortContentLens = [];
  result.lowEffortFinish = [];
  for (let i = 0; i < ATTEMPTS; i++) {
    const res = await chat(model, buildExhaustedBudgetMessages(), { tools: TOOLS, maxTokens: 1500, reasoningEffort: "minimal" });
    if (res.error) {
      const msg = res.error.message ?? JSON.stringify(res.error);
      console.log(`  attempt ${i + 1}: ERROR ${msg.slice(0, 150)}`);
      continue;
    }
    const len = (res.message.content ?? "").length;
    const calledMoreTools = (res.message.tool_calls ?? []).length > 0;
    console.log(`  attempt ${i + 1}: finish=${res.finish_reason} content_len=${len} called_more_tools=${calledMoreTools} reasoning_tokens=${res.usage?.completion_tokens_details?.reasoning_tokens}`);
    result.lowEffortContentLens.push(len);
    result.lowEffortFinish.push(res.finish_reason);
  }

  return result;
}

const results = [];
for (const model of MODELS) {
  results.push(await probeModel(model));
}

console.log("\n\n=== SUMMARY ===");
console.log("| Model | Tool calls (valid) | Post-tool content (chars) | Post-tool finish reasons | Verdict |");
console.log("|---|---|---|---|---|");
for (const r of results) {
  const toolStr = `${r.toolCalls}/${ATTEMPTS}`;
  const contentStr = r.postToolContentLens.join(", ") || "none";
  const finishStr = r.postToolFinish.join(", ") || "none";
  const emptyAnswers = r.postToolContentLens.filter((n) => n === 0).length;
  const verdict =
    r.toolCalls === ATTEMPTS && emptyAnswers === 0
      ? "works"
      : r.toolCalls === 0
        ? "broken (no tool calls)"
        : emptyAnswers > 0
          ? "broken (empty post-tool content)"
          : "flaky";
  console.log(`| ${r.model} | ${toolStr} | ${contentStr} | ${finishStr} | ${verdict} |`);
  console.log(`  low-effort post-tool: content=${r.lowEffortContentLens.join(", ") || "none"} finish=${r.lowEffortFinish.join(", ") || "none"}`);
  if (r.rateLimitRaw) console.log(`  ^ rate-limit message seen for ${r.model}: ${r.rateLimitRaw}`);
}
