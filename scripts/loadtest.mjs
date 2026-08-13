/**
 * Rate-limit / reliability harness for the week-2 agent.
 *
 * Drives the REAL endpoint (http://localhost:3000/api/agent) and reports, per
 * turn: latency, whether tools fired, whether an answer came back, and which
 * failure mode (if any). Also polls Groq's x-ratelimit-* headers between turns
 * so token burn is measured, not estimated.
 *
 * Usage:
 *   node loadtest.mjs smoke      one turn per prompt class, sequential, paced
 *   node loadtest.mjs burst      N turns as fast as possible (finds the wall)
 *   node loadtest.mjs convo      10-turn conversation on one session
 *   node loadtest.mjs soak       paced turns until something breaks
 */
import fs from "node:fs";
const root = new URL("..", import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, "");

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const KEY = /GROQ_API_KEY=(.+)/.exec(
  fs.readFileSync(root + "/.env.local", "utf8")
)[1].trim();

const MODELS = [
  "openai/gpt-oss-safeguard-20b",
  "openai/gpt-oss-20b",
  "openai/gpt-oss-120b",
];

// Prompt classes, cheapest -> most demanding.
const PROMPTS = {
  trivial: ["Hi", "What can you do?"],
  singleFact: [
    "What is pgvector?",
    "What is n8n used for?",
  ],
  calc: ["What is 2400 * 0.15?", "If I save 340 a month for 18 months, how much is that?"],
  webSearch: [
    "What is the latest LangChain version?",
    "What are the current visa requirements for Turkey for Pakistani citizens?",
  ],
  heavy: [
    "Plan a 9-day Turkey itinerary covering Istanbul, Antalya, Cappadocia, and Fethiye",
    "Compare Supabase, Firebase and Appwrite for a realtime chat app, with current pricing",
  ],
};

async function budget() {
  const out = {};
  for (const m of MODELS) {
    try {
      const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: m, max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
      });
      out[m.replace("openai/", "")] = {
        status: r.status,
        tok: Number(r.headers.get("x-ratelimit-remaining-tokens") ?? -1),
        req: Number(r.headers.get("x-ratelimit-remaining-requests") ?? -1),
      };
    } catch {
      out[m.replace("openai/", "")] = { status: 0, tok: -1, req: -1 };
    }
  }
  return out;
}

const DELIM = "\n__REASONING_TRACE__\n";

async function turn(sessionId, message) {
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(`${BASE}/api/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, sessionId }),
    });
  } catch (e) {
    return { verdict: "NETWORK", ms: Date.now() - t0, detail: e.message.slice(0, 60) };
  }

  if (!res.ok) {
    return { verdict: "HTTP_" + res.status, ms: Date.now() - t0, detail: (await res.text()).slice(0, 80) };
  }

  const body = await res.text();
  const ms = Date.now() - t0;
  const idx = body.indexOf(DELIM);
  const answer = (idx === -1 ? body : body.slice(0, idx)).trim();
  let trace = [];
  if (idx !== -1) {
    try { trace = JSON.parse(body.slice(idx + DELIM.length)); } catch {}
  }
  const toolsUsed = trace.filter((s) => s.type === "action").flatMap((s) => s.tool_calls.map((c) => c.name));

  // Classify the outcome.
  let verdict = "OK";
  if (!answer) verdict = "EMPTY_ANSWER";
  else if (/daily usage limit/i.test(answer)) verdict = "RL_DAILY";
  else if (/rate-limited/i.test(answer)) verdict = "RL_MINUTE";
  else if (/had trouble completing/i.test(answer)) verdict = "MODEL_TROUBLE";
  else if (/didn't return an answer/i.test(answer)) verdict = "NO_CONTENT";

  return { verdict, ms, chars: answer.length, tools: toolsUsed, preview: answer.slice(0, 60).replace(/\s+/g, " ") };
}

function line(label, r) {
  const tools = r.tools?.length ? r.tools.join("+") : "-";
  console.log(
    "  " + String(label).padEnd(26) +
    String(r.verdict).padEnd(15) +
    String(r.ms + "ms").padStart(7) +
    "  chars=" + String(r.chars ?? 0).padStart(5) +
    "  tools=" + tools.padEnd(24) +
    (r.detail ? " " + r.detail : "")
  );
}

function burn(before, after) {
  const parts = [];
  for (const k of Object.keys(before)) {
    const d = before[k].tok - after[k].tok;
    if (d > 0) parts.push(k + " -" + d);
  }
  return parts.length ? parts.join(", ") : "no measurable burn";
}

const sid = () => "test" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function smoke() {
  console.log("\n### SMOKE — one turn per class, 20s apart (should ALL pass)\n");
  for (const [cls, list] of Object.entries(PROMPTS)) {
    const before = await budget();
    const r = await turn(sid(), list[0]);
    const after = await budget();
    line(cls, r);
    console.log("      burn: " + burn(before, after));
    await sleep(20000);
  }
}

async function burst() {
  const N = Number(process.argv[3] ?? 5);
  console.log(`\n### BURST — ${N} HEAVY turns back-to-back, no pause (finds the wall)\n`);
  const before = await budget();
  console.log("  start budget: " + JSON.stringify(before) + "\n");
  const results = [];
  for (let i = 0; i < N; i++) {
    const r = await turn(sid(), PROMPTS.heavy[i % PROMPTS.heavy.length]);
    line("turn " + (i + 1), r);
    results.push(r);
    if (r.verdict.startsWith("RL_")) {
      console.log(`\n  >>> first rate limit at turn ${i + 1}`);
      break;
    }
  }
  const after = await budget();
  console.log("\n  burn: " + burn(before, after));
  const ok = results.filter((r) => r.verdict === "OK").length;
  console.log(`  survived ${ok}/${results.length} back-to-back heavy turns`);
}

async function convo() {
  console.log("\n### CONVO — 10 turns, ONE session, 15s apart (memory growth check)\n");
  const s = sid();
  const seq = [
    "What is pgvector?",
    "What is 2400 * 0.15?",
    "What is the latest LangChain version?",
    "What was my first question?",
    "Plan a 3-day Istanbul itinerary",
    "What is n8n used for?",
    "How much is 45 * 89?",
    "What did we discuss about pgvector?",
    "Compare Supabase and Firebase briefly",
    "Summarise everything we talked about",
  ];
  const before = await budget();
  for (let i = 0; i < seq.length; i++) {
    const r = await turn(s, seq[i]);
    line(`t${i + 1} ${seq[i].slice(0, 18)}`, r);
    await sleep(15000);
  }
  const after = await budget();
  console.log("\n  total burn over 10 turns: " + burn(before, after));
}

async function soak() {
  console.log("\n### SOAK — heavy turns every 35s until failure (max 20)\n");
  for (let i = 0; i < 20; i++) {
    const r = await turn(sid(), PROMPTS.heavy[i % PROMPTS.heavy.length]);
    line("turn " + (i + 1), r);
    if (r.verdict !== "OK") {
      console.log(`\n  >>> first failure at turn ${i + 1}: ${r.verdict}`);
      return;
    }
    await sleep(35000);
  }
  console.log("\n  20 turns with no failure");
}

const mode = process.argv[2] ?? "smoke";
const modes = { smoke, burst, convo, soak };
if (!modes[mode]) {
  console.log("modes: smoke | burst [N] | convo | soak");
  process.exit(1);
}
console.log("target: " + BASE + "  mode: " + mode);
await modes[mode]();
