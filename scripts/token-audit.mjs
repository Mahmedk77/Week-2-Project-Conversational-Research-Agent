// Measure REAL prompt_tokens (Groq's own counter) for each layer of the
// per-request payload, and for each step of the agent loop.
import fs from "node:fs";

const root = new URL("..", import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, "");
const KEY = /GROQ_API_KEY=(.+)/.exec(fs.readFileSync(root + "/.env.local", "utf8"))[1].trim();
const src = fs.readFileSync(root + "/app/api/agent/route.ts", "utf8");

const spStart = src.indexOf("const SYSTEM_PROMPT");
const o = src.indexOf("`", spStart);
const c = src.indexOf("`;", o + 1);
const SYSTEM_PROMPT = src.slice(o + 1, c);

// Rebuild the tool definitions LangChain sends (names/descriptions/schemas).
const TOOLS = [
  {
    type: "function",
    function: {
      name: "knowledge_base_search",
      description: "Search the internal knowledge base for facts about LangChain, Supabase, n8n, and CRMs. Accepts ONLY: query (required string). Example: {\"query\": \"pgvector\"}",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: {} },
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
          url: { type: "string" },
          maxResults: { type: "integer", minimum: 1, maximum: 10, description: "How many results, default 3" },
          recencyDays: { type: "integer", minimum: 1, description: "Only results from the last N days" },
        },
        additionalProperties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "calculator",
      description: "Evaluates a math expression using + - * / and parentheses. Accepts ONLY: expression (required string). Example: {\"expression\": \"34 * 0.15\"}",
      parameters: { type: "object", properties: { expression: { type: "string" } }, required: ["expression"], additionalProperties: {} },
    },
  },
];

const MODEL = "openai/gpt-oss-safeguard-20b";

async function promptTokens(messages, tools) {
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 1, messages, ...(tools ? { tools } : {}) }),
  });
  const j = await r.json();
  if (!j.usage) return "ERR: " + (j.error?.message ?? "").slice(0, 70);
  return j.usage.prompt_tokens;
}

const U = (t) => [{ role: "user", content: t }];
const Q = "Plan a 9-day Turkey itinerary covering Istanbul, Antalya, Cappadocia, and Fethiye";

console.log("=== FIXED OVERHEAD (real Groq prompt_tokens) ===");
const bare = await promptTokens(U("hi"));
console.log("  bare 'hi'                       ", bare);

const withTools = await promptTokens(U("hi"), TOOLS);
console.log("  + tool definitions              ", withTools, " (delta " + (withTools - bare) + ")");

const withSys = await promptTokens([{ role: "system", content: SYSTEM_PROMPT }, ...U("hi")], TOOLS);
console.log("  + system prompt                 ", withSys, " (delta " + (withSys - withTools) + ")");

const withQ = await promptTokens([{ role: "system", content: SYSTEM_PROMPT }, ...U(Q)], TOOLS);
console.log("  + real question                 ", withQ, " (delta " + (withQ - withSys) + ")");

const summary = "x".repeat(400);
const withMem = await promptTokens(
  [{ role: "system", content: SYSTEM_PROMPT }, ...U(`[Context from earlier in this conversation: ${summary}]\n\n${Q}`)],
  TOOLS
);
console.log("  + 400-char memory summary       ", withMem, " (delta " + (withMem - withQ) + ")");

console.log("\n=== THE AGENT LOOP (what actually gets billed) ===");
const toolResult = JSON.stringify([
  { title: "Turkey 9-Day Tours", url: "https://example.com/aaaaaaaaaaaa", snippet: "x".repeat(150) },
  { title: "Cappadocia Guide", url: "https://example.com/bbbbbbbbbbbb", snippet: "x".repeat(150) },
  { title: "Fethiye & Antalya", url: "https://example.com/cccccccccccc", snippet: "x".repeat(150) },
]);

const step1msgs = [{ role: "system", content: SYSTEM_PROMPT }, ...U(Q)];
const s1 = await promptTokens(step1msgs, TOOLS);

const step2msgs = [
  ...step1msgs,
  { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "web_search", arguments: JSON.stringify({ query: "9 day Turkey itinerary Istanbul Cappadocia" }) } }] },
  { role: "tool", tool_call_id: "c1", content: toolResult },
];
const s2 = await promptTokens(step2msgs, TOOLS);

const step3msgs = [
  ...step2msgs,
  { role: "assistant", content: "", tool_calls: [{ id: "c2", type: "function", function: { name: "web_search", arguments: JSON.stringify({ query: "Antalya Fethiye attractions 2026" }) } }] },
  { role: "tool", tool_call_id: "c2", content: toolResult },
];
const s3 = await promptTokens(step3msgs, TOOLS);

console.log("  call 1 (decide tool)            ", s1);
console.log("  call 2 (after 1 tool result)    ", s2, " (+" + (s2 - s1) + ")");
console.log("  call 3 (after 2 tool results)   ", s3, " (+" + (s3 - s2) + ")");
console.log("  ------------------------------------------");
console.log("  cumulative INPUT for the turn   ", s1 + s2 + s3);
console.log("  as % of the 8000 TPM bucket     ", Math.round(((s1 + s2 + s3) / 8000) * 100) + "%");

console.log("\n=== WHERE THE FIXED COST GOES ===");
const sysOnly = withSys - withTools;
const toolsOnly = withTools - bare;
const fixed = sysOnly + toolsOnly;
console.log("  system prompt   ", sysOnly, "tok  x3 calls =", sysOnly * 3);
console.log("  tool defs       ", toolsOnly, "tok  x3 calls =", toolsOnly * 3);
console.log("  fixed subtotal  ", fixed, "tok  x3 calls =", fixed * 3, "  <-- paid every call");
