import { ChatOpenAI } from "@langchain/openai";
import { createClient } from "@supabase/supabase-js";
import { tavily } from "@tavily/core";

/**
 * Per-generation output ceiling.
 *
 * Sized from measurement, not guesswork: a complete 9-day itinerary answer
 * (the hardest case tested) needs ~1,234 completion tokens. At 800 that answer
 * came back `finish_reason: "length"`, cut mid-word; at 1500 it finished
 * cleanly with `finish_reason: "stop"`.
 *
 * Cost is modest because output is NOT multiplied by the agent loop — the
 * tool-deciding steps emit only a short tool call (~30-80 tokens) and just the
 * final answer is long. So this adds tokens once per turn, not once per step,
 * and it is a ceiling rather than a target: short answers are unaffected.
 *
 * If this is ever lowered again, lower the "~1500 tokens" figure quoted in
 * SYSTEM_PROMPT to match — the model is told this number.
 */
const MAX_OUTPUT_TOKENS = 1500;

function groqChatModel(model: string) {
  return new ChatOpenAI({
    model,
    apiKey: process.env.GROQ_API_KEY,
    maxTokens: MAX_OUTPUT_TOKENS,
    configuration: {
      baseURL: "https://api.groq.com/openai/v1",
    },
  });
}

/**
 * Agent models in fallback order. Each Groq model has its OWN independent
 * rate-limit bucket, so when one is exhausted we retry the same request on the
 * next instead of making the user wait — which matters most for the daily
 * (TPD) cap, since that does not roll over for hours.
 *
 * Order is based on DIRECT PROBING of both halves of the agent loop — a model
 * must (a) emit valid tool-call JSON and (b) produce visible content after a
 * tool result. Measured, 5 attempts each:
 *
 *   gpt-oss-safeguard-20b  tools 5/5   post-tool 2511 chars   <- both pass
 *   gpt-oss-20b            tools 5/5   post-tool 2069 chars   <- both pass
 *   gpt-oss-120b           tools 5/5   post-tool 0 CHARS      <- BROKEN, removed
 *   llama-3.3-70b          tools 1/5   (mangles tool name)    <- BROKEN
 *   llama-3.1-8b           tools 4/5   post-tool ok           <- flaky
 *   qwen3.6-27b            leaks raw <think> into content, always finish=length
 *
 * Only the two models that pass BOTH halves are in the chain. `gpt-oss-120b`
 * was tried as a third and removed: it calls tools correctly but returns zero
 * content after a tool result, so it can only ever contribute an empty answer
 * or a failed request — extra latency and tokens for no possible benefit. A
 * third model is worth adding only if it passes both probes in
 * `scripts/` first.
 *
 * Both entries share identical tool-calling behaviour, so one schema suits
 * both and a fallback never changes answer quality.
 *
 * Do NOT add `groq/compound` or `groq/compound-mini`: agentic "Systems" with
 * built-in tools, incompatible with bindTools() (confirmed 400 error).
 */
export const AGENT_MODEL_CHAIN = [
  "openai/gpt-oss-safeguard-20b",
  "openai/gpt-oss-20b",
] as const;

export const agentModels = AGENT_MODEL_CHAIN.map((model) => ({
  model,
  instance: groqChatModel(model),
}));

export const groqSummaryModel = new ChatOpenAI({
  model: "llama-3.1-8b-instant",
  apiKey: process.env.GROQ_API_KEY,
  configuration: {
    baseURL: "https://api.groq.com/openai/v1",
  },
});

export const openRouterModel = new ChatOpenAI({
  model: "inclusionai/ling-3.0-tiny:free",
  apiKey: process.env.OPENROUTER_API_KEY,
  configuration: {
    baseURL: "https://openrouter.ai/api/v1",
  },
});

export const tavilyClient  = tavily({ 
  apiKey: process.env.TAVILY_API_KEY 
});

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const supabase = createClient(
  requireEnv("SUPABASE_URL"),
  requireEnv("SUPABASE_ANON_KEY")
)

