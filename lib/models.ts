import { ChatOpenAI } from "@langchain/openai";
import { createClient } from "@supabase/supabase-js";
import { tavily } from "@tavily/core";

/**
 * Per-generation output ceiling.
 *
 * Sized from measurement, not guesswork: a complete 9-day itinerary answer
 * (the hardest case tested) needs ~1,234 completion tokens on a non-reasoning
 * model. At 800 that answer came back `finish_reason: "length"`, cut mid-word;
 * at 1500 it finished cleanly with `finish_reason: "stop"`.
 *
 * Raised to 3000 for the gpt-5 migration: gpt-5/gpt-5-mini are reasoning
 * models whose hidden reasoning tokens are billed out of this SAME budget
 * (`max_completion_tokens`, OpenAI's own naming). Probed directly against the
 * real API with the real tool schemas post-tool-result (search budget
 * exhausted, matching what the app actually sends): at 1500 + default
 * reasoning effort, gpt-5 returned a BLANK answer 3/3 attempts
 * (`finish_reason: "length"`, all 1500 tokens spent on invisible reasoning,
 * zero visible content) — the same "tool ran, answer blank" symptom as the
 * Groq `gpt-oss-120b` bug, different mechanism. `reasoning: { effort:
 * "minimal" }` below fixed gpt-5 outright (3/3 clean, 0 reasoning tokens), but
 * gpt-5-mini still burned its full 1500 on reasoning in 1/3 attempts even at
 * "minimal". Raising the ceiling to 3000 gave enough headroom for a clean 5/5
 * at minimal effort. See scripts/probe-openai-models.mjs.
 *
 * Cost is modest because output is NOT multiplied by the agent loop — the
 * tool-deciding steps emit only a short tool call (~30-80 tokens) and just the
 * final answer is long. So this adds tokens once per turn, not once per step,
 * and it is a ceiling rather than a target: short answers are unaffected.
 *
 * If this is ever lowered again, lower the "~3000 tokens" figure quoted in
 * SYSTEM_PROMPT to match — the model is told this number. Do not lower below
 * ~2500 without re-running the probe script first.
 */
const MAX_OUTPUT_TOKENS = 3000;

function openAIChatModel(model: string) {
  return new ChatOpenAI({
    model,
    apiKey: process.env.OPENAI_API_KEY,
    maxTokens: MAX_OUTPUT_TOKENS,
    // Reasoning effort forced to the minimum: gpt-5/gpt-5-mini are reasoning
    // models by default, and at OpenAI's default effort every reasoning token
    // is billed out of the same MAX_OUTPUT_TOKENS budget as the visible
    // answer (see comment above) — probed to make gpt-5 return a BLANK answer
    // 3/3 times. "minimal" makes both models behave like a normal fast model
    // (0 hidden reasoning tokens in nearly all probed runs) without hurting
    // tool-calling or answer quality in testing. Do not remove this.
    reasoning: { effort: "minimal" },
    // No `configuration.baseURL` override here on purpose: this hits
    // OpenAI's real API directly. Groq/OpenRouter below point the same
    // ChatOpenAI client at a third-party OpenAI-compatible endpoint instead.
  });
}

/**
 * Agent models in fallback order, on OpenAI's paid API.
 *
 * PREVIOUSLY this chain ran on Groq's free tier (`gpt-oss-safeguard-20b` then
 * `gpt-oss-20b`). That two-model fallback existed mainly to spread load
 * across Groq's tiny, separate 8K-TPM-per-model free-tier buckets, and both
 * models needed direct probing because small open models were flaky at tool
 * calling: `gpt-oss-120b` returned zero content after a tool call,
 * `llama-3.3-70b` mangled the tool call itself 4 times out of 5, and
 * `qwen3.6-27b` leaked raw `<think>` tags into the visible answer. See this
 * file's git history for the full probe results if Groq is ever revisited.
 *
 * `gpt-5-mini` is PRIMARY, not `gpt-5`, deliberately: on a paid account every
 * token has a real cost, and mini is materially cheaper for what is mostly a
 * tool-orchestration + moderate-length-answer workload. `gpt-5` sits behind
 * it purely as a fallback for an outage or rate limit on mini, not because it
 * answers better for this use case.
 *
 * Both models were probed the same way every Groq model was (see
 * scripts/probe-openai-models.mjs and CONVERSATION_SUMMARY.md /
 * HANDOFF.md): real tool schemas, both tool-calling and post-tool-answering
 * halves of the loop, search-budget-exhausted state. Both are reliable
 * (5/5 and 3/3 clean respectively) ONLY with the `reasoning: { effort:
 * "minimal" }` + `MAX_OUTPUT_TOKENS = 3000` settings above — at OpenAI's
 * default reasoning effort `gpt-5` returned a BLANK post-tool answer 3/3
 * times (hidden reasoning tokens ate the whole output budget). Do not drop
 * either setting when touching this chain.
 *
 * Two models are kept here, not one, purely for resilience against a
 * transient outage or a rate limit on one specific SKU. Swap or trim this
 * list freely — nothing else in the codebase assumes a particular size or
 * provider, since agentModels is built generically from this array.
 */
export const AGENT_MODEL_CHAIN = [
  "gpt-5-mini",
  "gpt-5",
] as const;

export const agentModels = AGENT_MODEL_CHAIN.map((model) => ({
  model,
  instance: openAIChatModel(model),
}));

/**
 * Conversation-summary model. Deliberately LEFT ON GROQ: this call was never
 * the source of a rate-limit or reliability issue anywhere in the Groq
 * hardening work, and the task itself is low-stakes (a running summary capped
 * at 400 characters). No reason to spend paid OpenAI tokens on it.
 *
 * Was `llama-3.1-8b-instant` — Groq removed it from this account entirely
 * (confirmed via GET /v1/models: no longer listed, calls now 404
 * `model_not_found`, discovered live in production during the OpenAI
 * migration testing on 2026-09-05). `openai/gpt-oss-20b` was already the
 * project's own verified choice for real content generation (see
 * CONVERSATION_SUMMARY.md's probe table: 5/5 tool calls, 2069 chars of real
 * post-tool content — the same model driving the old main agent chain before
 * this file switched that to OpenAI). Re-probed directly against this exact
 * summarization prompt: 3/3 clean, no leaked labels/preamble, well under the
 * 400-char cap. If Groq models disappear again, `GET
 * https://api.groq.com/openai/v1/models` lists what's actually still on the
 * account — don't assume the docs or an old model id are still valid.
 */
export const groqSummaryModel = new ChatOpenAI({
  model: "openai/gpt-oss-20b",
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
