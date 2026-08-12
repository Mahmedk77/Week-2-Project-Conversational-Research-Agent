# Week 2 Project — Conversation Summary

Context handoff doc for continuing work on this app in a new conversation. Project: a Next.js (App Router, TypeScript, Tailwind) conversational research agent with a LangChain/LangGraph backend on Groq, Supabase for memory/knowledge base, and Tavily for web search.

## Stack
- **Frontend**: Next.js App Router, TypeScript, Tailwind, `react-markdown` + `remark-gfm` for rendering AI responses, Lora serif font, warm neutral palette (`--bg-page`, `--text-primary`, `--surface-1`, `--border` CSS vars)
- **Backend**: `app/api/agent/route.ts` — single POST endpoint, streams plain text + a `\n__REASONING_TRACE__\n` delimiter + JSON array of tool-call/observation steps
- **Models** (`lib/models.ts`):
  - `groqModel` — `openai/gpt-oss-20b` on Groq, main tool-calling agent, `maxTokens: 500`
  - `groqSummaryModel` — `llama-3.1-8b-instant` on Groq, used only for conversation summarization
  - `openRouterModel` — defined but currently **unused** (was wired into a classifier/routing experiment that got reverted; model id is `inclusionai/ling-3.0-tiny:free`)
- **Tools**: `knowledge_base_search` (Supabase), `web_search` (Tavily, supports `maxResults`/`recencyDays`), `calculator`
- **Memory**: per-session running summary stored in Supabase `agent_memory` table, capped at 800 chars, regenerated every turn via `groqSummaryModel`

## Chat UI — built this session
- `app/page.tsx` — orchestrates streaming fetch, delimiter parsing, session id (random, in-memory, not localStorage), error categorization
- `app/components/`: `ChatMessageItem` (user bubble / plain-text AI, copy + retry buttons), `ReasoningTrace` (collapsible, cleaned/truncated tool-call summaries), `MarkdownContent` (styled markdown incl. tables with horizontal scroll), `ChatInput` (auto-growing textarea, no native scrollbar arrows), `EmptyState` (greeting + suggestion cards)
- Design: ChatGPT-style bubble/no-bubble pattern, CentralAI-style empty state, mobile-responsive, dark-mode-ready (currently light-only per latest palette task)
- Retry button: sits next to copy icon on every AI message, resends the preceding user message without duplicating it in the transcript

## The core recurring problem: Groq free-tier rate limits
Account is on Groq's **free tier**, not the "Developer plan" numbers Groq's docs show — actual observed ceiling is ~6000-8000 TPM (tokens per minute), confirmed repeatedly via real 429 error logs (`Limit 8000, Used X, Requested Y`). This is a **per-minute token-sum** limit, not a request-count limit — a single large request (e.g. multi-day travel itinerary needing tool calls + a long generated answer) can alone approach or exceed the ceiling.

### Fixes applied (kept)
1. **`groqSummaryModel` split off from main agent** — cheap/fast model for summarization only, so that second LLM call per turn doesn't compete at full cost
2. **`MAX_SUMMARY_CHARS = 800`** — hard cap + prompt instruction on the saved conversation summary (was previously unbounded and growing every turn)
3. **Tool-result truncation** — `MAX_TOOL_SNIPPET_CHARS` truncates KB/web search result content before it reaches the agent (titles/topics stay full-length)
4. **`maxTokens: 500` on `groqModel`** — hard cap on generated output (previously unset/unbounded)
5. **"Length discipline" system prompt section** — instructs the model to give compact overviews for multi-part requests (itineraries, comparisons) instead of exhaustive breakdowns, and offer to expand rather than pre-writing everything
6. **Rate-limit-aware error handling** — backend detects 429s (`RateLimitQuotaExhaustedError`/`RateLimitCapacityError`/status 429), parses the actual retry-after seconds out of Groq's error message text (LangChain's `retryAfterMs` metadata wasn't reliably populated, so this is regex-parsed from the message), and streams back a clean "The model is currently rate-limited. Please try again in about Ns." as normal message content — never a raw error
7. **Retry button** in the UI — lets the user manually resend after a rate-limit hit

### Tried and reverted (do not re-attempt without new reasoning)
- **Classifier/routing** (a cheap pre-check to decide "does this need tools" and route simple messages to a separate fast/direct model via OpenRouter, skipping the full agent) — implemented, worked in testing, then explicitly reverted at user's request in favor of simplicity. `openRouterModel` still exists in `lib/models.ts` but is unwired.
- **Forced `tool_choice: "required"`** on `groqModel.bindTools()` for messages matching a "factual risk" regex (travel/planning/pricing keywords) — this was meant to fix the model *skipping* tools on things like travel itineraries. It worked for that, but introduced a new failure: forcing tool use made the smaller model more prone to emitting **malformed tool-call JSON** (`"Failed to parse tool call arguments as JSON"` in production/LangSmith traces). Reverted back to prompt-only enforcement per user's explicit instruction.

### Token budget: measured breakdown (do this math before optimizing further)
The key mechanism, previously missed: **LangGraph resends the full message history on every step of the agent loop.** A 2-tool-call turn = 3 LLM calls, so every *fixed* token (system prompt, tool descriptions, memory summary) is billed ~3x per turn. This is why trimming the system prompt beats trimming tool results.

Measured before optimization (~4 chars/token estimate), typical 2-tool turn:

| Component | Tokens (x3 loop) | Share |
|---|---|---|
| System prompt (3619 chars) | ~2715 | 55% |
| Memory summary (800 cap) | ~600 | 12% |
| Tool descriptions | ~530 | 11% |
| Tavily results | ~560 | 11% |
| User message | ~150 | 3% |

Cumulative input was **4920 tok**; +1500 worst-case output = **6420 / 8000 TPM (80% of budget)**.

**Tavily was only ~11%** — it is NOT the main driver, despite being the intuitive suspect. Optimizing it alone could never fix this.

### Optimization applied (this session)
- **System prompt compressed 3619 -> 1900 chars** (~905 -> ~475 tok). Hoisted to a module-level `SYSTEM_PROMPT` const. All 20 distinct behavioural rules verified still present — only repetition and justification prose was cut. **Do not drop a rule when editing; each was added for an observed failure.**
- **Tool descriptions 548 -> 311 chars** — removed prose duplicating the zod schema. `maxResults`/`recencyDays` still described in the schema (they fixed a real crash).
- **`MAX_SUMMARY_CHARS` 800 -> 400** — earlier analysis left this at 800 after judging it a minor driver, but that didn't account for the 3x loop multiplier.
- **`MAX_TOOL_SNIPPET_CHARS` 200 -> 150**. Titles/URLs left intact (URLs would break citations).

Result: input **4920 -> 3039 tok (-38%)**; total **6420 -> 4539 / 8000 (57% of budget)**. Headroom roughly doubled: 1580 -> 3461 tok.

### Confirmed Groq free-tier limits (from Groq docs, not inferred)
Per-model, independent buckets:

| Model | RPM | RPD | TPM | TPD |
|---|---|---|---|---|
| `openai/gpt-oss-120b` | 30 | 1K | 8K | 200K |
| `openai/gpt-oss-20b` | 30 | 1K | 8K | 200K |
| `qwen/qwen3.6-27b` | 30 | 1K | 8K | 200K |
| `llama-3.3-70b-versatile` | 30 | 1K | 12K | 100K |
| `llama-3.1-8b-instant` | 30 | 14.4K | 6K | 500K |

**TPD matters as much as TPM.** A real trace hit `TPD: Limit 200000, Used 197997` — a *daily* exhaustion, not per-minute. Groq still quotes a short "try again in 1m4s" hint on TPD errors, which is misleading; you cannot recover a day's tokens in a minute.

Note RPD is consumed per *agent-loop step*, not per user turn: a 2-tool turn = 3 requests, so 1K RPD ≈ 330 turns/day. At ~5.4K tok/turn, TPD (200K) binds first at ~37 turns/day.

### Real measured token cost (LangSmith trace, post-compression)
| | Estimate | Actual |
|---|---|---|
| Call 1 | ~743 | **845** |
| Call 2 | ~1013 | **1300** |
| Full 3-call turn | ~3039 | **5400** |

The ~4 chars/token heuristic **under-counts by 15-30%** (message envelope + tool-call JSON aren't in raw char count). Trust LangSmith over estimates. The 3-call/2-tool loop shape was confirmed, and `web_search` still fires after compression.

### Model fallback chain (this session)
`lib/models.ts` now exports `AGENT_MODEL_CHAIN` / `agentModels` instead of a single `groqModel`:
`openai/gpt-oss-120b` (primary) -> `openai/gpt-oss-20b` -> `qwen/qwen3.6-27b`

On a 429 the route rebuilds the agent on the next model and retries — each has its own 8K TPM / 200K TPD bucket, so this raises effective capacity ~3x and, crucially, survives a TPD exhaustion that waiting cannot fix. Rules encoded in `app/api/agent/route.ts`:
- Only **rate-limit** errors fall through; any other error (e.g. malformed tool-call JSON) propagates immediately.
- Fallback only happens **before any text has streamed**. Mid-stream 429 keeps the partial answer and appends the notice rather than restarting (restarting would duplicate visible output).
- When the whole chain is exhausted, `isDailyLimitError` picks TPD vs TPM wording.
- **Do not add `groq/compound` / `compound-mini`** — incompatible with `bindTools()` (400).

Control flow verified by simulation across 7 scenarios (chain advance, mid-stream duplication guard, non-rate-limit passthrough, TPD vs TPM messaging).

**Not yet validated against live Groq:** whether `gpt-oss-120b` and `qwen3.6-27b` handle the tool schemas as reliably as `20b` did. If a fallback model is worse at tool-calling, the app silently degrades under load — reorder or drop entries in `AGENT_MODEL_CHAIN` (one-line change) if testing shows this.

### MODEL SELECTION: probe BOTH halves of the agent loop (hard-won)
A model must pass **two independent tests** to work here, and passing one says nothing about the other:
1. **Tool call** — emit valid tool-call JSON for the real schema
2. **Post-tool completion** — produce visible `content` on the step *after* a tool result

Measured directly against the Groq API, 5 attempts each, real schema + real tool result:

| Model | Tool calls | Post-tool content | Verdict |
|---|---|---|---|
| `openai/gpt-oss-safeguard-20b` | 5/5 | 2511 chars | **works** |
| `openai/gpt-oss-20b` | 5/5 | 2069 chars | **works** |
| `openai/gpt-oss-120b` | 5/5 | **0 chars** | **broken** |
| `llama-3.3-70b-versatile` | 1/5 (mangles tool *name*) | 902 chars | broken |
| `llama-3.1-8b-instant` | 4/5 | 1109 chars | flaky |
| `qwen/qwen3.6-27b` | — | leaks raw `<think>` into content, always `finish=length` | unusable |

**`gpt-oss-120b` calls tools perfectly and then returns ZERO content** — a few reasoning tokens, no answer. Raising `maxTokens` (800, 2000) does not help; it is not truncation. This produced the "tool ran, reasoning trace shows, answer blank" symptom.

Current chain: `gpt-oss-safeguard-20b` -> `gpt-oss-20b` -> `gpt-oss-120b` (last only as better-than-nothing).

**Methodology warning:** an earlier probe tested only the *first* model call and concluded "120b is fine". It passed that test and still broke the app. Always probe the post-tool step too.

### Tool schemas are LOOSE on purpose — do not tighten them
The model has invented a different set of extra tool parameters in three separate traces:
1. `topn` / `recency_days`
2. `url` (echoed back from the tool's own result objects)
3. `id` / `cursor`

Each was a **hard crash**, because a strict `z.object()` compiles to `additionalProperties: false` and LangChain validates before the tool body runs — so it cannot be caught in the handler. Denying unknown keys one at a time is unwinnable.

All three tools now use **`z.looseObject()`** (Zod 4; `.passthrough()` is deprecated but equivalent), which emits `additionalProperties: {}`. Unknown keys are accepted and ignored — only the declared fields are ever read. Verified: all four historical failure payloads now parse.

**Do not "clean this up" by switching back to `z.object()`.** The looseness is the fix.

### Bug: stale rate-limit error reported after chain exhaustion
`lastRateLimitError` was set but never cleared, so once ANY model 429'd, a later chain exhaustion from a *different* cause still reported "daily usage limit reached". This produced a wrong user-facing message while all three models were actually healthy (verified via `x-ratelimit-remaining-tokens`). Fixed by reporting the cause of the **last** failure (`lastRetryableError`) rather than any rate limit seen earlier.

### Empty answers now trigger fallback
A run that completes with no answer text is treated as a retryable failure, not a success — the chain advances. If the last model also returns nothing, the user gets an explicit message instead of an empty bubble.

### Tool-calling: `gpt-oss-120b` emits valid tool JSON (probed, don't re-litigate)
After switching the primary to `120b`, traces showed `Failed to parse tool call arguments as JSON`. The intuitive read — "120b is bad at tool calling" — was **tested and disproved**.

Direct probe against the raw Groq API (5 attempts x 3 configs, travel-itinerary prompt, real tool schema):

| Config | Result |
|---|---|
| `120b` + current long description | **5/5 valid** |
| `120b` + short description | **5/5 valid** |
| `20b` + long description | **5/5 valid** |

15/15 clean, correct `query` every time, no invented keys. **The models emit valid tool-call JSON.**

The failure is therefore in **LangChain's streaming reassembly**, not generation — the stack trace lands in `ChatOpenAICompletions._streamResponseChunks`, and the probe (non-streaming) never reproduced it. Tool-call arguments arrive split across SSE deltas; a truncated or badly-split stream yields an unparseable fragment. The failing trace fits: 2.10s, aborted on the first `model_request`, tool node never ran.

Leading hypothesis (**not yet confirmed**): `maxTokens` truncating output while tool-call arguments are still streaming. `120b` is more verbose than `20b`, so it hit the ceiling sooner. Mitigated by raising `maxTokens` 500 -> 800 (`MAX_OUTPUT_TOKENS` in `lib/models.ts`; system prompt updated to match — keep those two in sync).

### Fallback now covers tool-parse errors too
`isToolCallParseError` matches both observed strings ("failed to parse tool call arguments", "tool call validation failed"). Since the cause is transient/stream-level rather than model-specific, these now fall through to the next model instead of failing the request. Rules:
- Retryable: rate limits **and** tool-parse errors. Everything else fails fast.
- Still never retries after text has streamed (duplication guard).
- Chain exhausted by parse errors -> generic "please try again", not a rate-limit message.

Verified by simulation (5 scenarios, 4 assertions) and the detector was checked against the two real trace strings.

### `web_search` schema hardening
The model was observed sending `{url: ...}` — because the tool *returns* objects containing `url` and it echoed one back. The schema now **tolerates `url` without advertising it** and folds it into the query, converting a hard validation crash into a working search. `query` is optional in the zod schema but enforced in the tool body. Description explicitly names the only accepted params and states that URLs are not accepted.

**Lesson:** tool descriptions are load-bearing for schema compliance on small models — do not compress them as aggressively as the system prompt. The earlier compression of this description preceded the `url` crash.

### Security fixes (this session)
- **Calculator RCE risk**: was `Function("return (" + expr + ")")` on model-generated input behind a charset regex. Replaced with a recursive-descent parser that can only return a number. Verified 13/13 attack strings rejected, 10/10 math cases correct. **Never reintroduce `Function`/`eval` here.**
- **PostgREST injection**: `.or()` filter was string-concatenated with the untrusted query; `a),id.gte.0,and(id.gte.0` restructured the filter tree. Added `escapeOrFilterValue`.
- **Unbounded input**: `MAX_MESSAGE_CHARS = 4000` on `message` (abuse vector + token driver).
- Hardened `request.json()` (was unguarded), type-checked `message`/`sessionId`, added `SESSION_ID_PATTERN` (verified against 200k frontend-generated ids, zero false rejections), enforced summary cap on read, stopped leaking Supabase error text to clients, replaced `any[]` trace with the shared `ReasoningStep` type.

**Still open (needs a decision, not a patch):** no auth or rate limiting on either endpoint. `sessionId` is client-generated and unauthenticated, so anyone can read/wipe another session's memory by supplying its id, and `/api/agent` can be looped to burn Groq/Tavily quota. Proper fix = signed httpOnly cookie + per-IP rate limit.

### Open, not yet solved
- Prompt-only tool enforcement (the current state) is **not 100% reliable** — the model has skipped `web_search` on at least one travel-itinerary-style request despite explicit "MUST call web_search" rules in the system prompt naming that exact scenario as an example. No structural fix currently in place for this; only the prompt instruction.
- `MAX_SUMMARY_CHARS` was reconsidered but left at 800 — analysis showed it's not the primary token driver (tool results + generated output dominate), so lowering it further wasn't pursued.

## Other fixes made this session (not rate-limit related)
- **Memory/context bug**: the conversation summary was injected as a `role: "system"` message alongside `createAgent`'s own system prompt — models don't reliably treat a second system message as real conversational history. Fixed by folding the summary into the **user** message as inline context instead (`[Context from earlier in this conversation: ...]\n\n{message}`). This fixed a bug where asking "what was my first question" got a wrong/hallucinated answer despite the summary being correctly stored.
- **Summary quality bug**: the summarization prompt's own field labels ("Existing summary:", "New exchange:") were being echoed literally into the saved summary text by the smaller model. Fixed by rewriting the prompt to explicitly forbid labels/preamble and demand third-person plain-fact output only.
- **`web_search` production crash**: model invented `topn`/`recency_days` parameters that didn't exist in the tool's zod schema, causing a validation crash. Fixed by actually adding real `maxResults`/`recencyDays` optional params (backed by Tavily's real API options) instead of just constraining the schema tighter.
- **Frontend error miscategorization**: a server-side stream failure (e.g. tool-call error) was being labeled "Couldn't reach the server" (network category) because both real network failures and browser-side stream-read errors throw the same generic `TypeError`. Fixed by tracking a `streamStarted` flag so post-stream-start failures are correctly categorized as server errors, never network errors.
- **UI polish**: markdown table styling/spacing, Lora font, warm palette, header/surface depth fixes, hidden scrollbar on textarea and tables, auto-growing chat input (fixed a bug where long messages showed native scrollbar arrows), favicon (bot-message-square icon matching the app's avatar), mobile responsiveness audit (tap targets, table scroll-fade affordance).

## Key files
- `app/api/agent/route.ts` — all backend logic, tools, system prompt, streaming, error handling
- `lib/models.ts` — model instances
- `app/page.tsx` — frontend chat state, streaming fetch, retry logic
- `app/components/*.tsx` — UI components
- `app/globals.css` — palette, fonts, scrollbar/scroll-fade utilities

## Known environment notes
- Groq account confirmed **free tier** — real available models checked directly in Groq console: `llama-3.1-8b-instant`, `llama-3.3-70b-versatile`, `openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `openai/gpt-oss-safeguard-20b`, `qwen/qwen3.6-27b`, `groq/compound` / `groq/compound-mini` (these last two are agentic "Systems" with built-in tools, **incompatible** with our external `bindTools()` approach — confirmed via 400 error, do not retry)
- `OPENROUTER_API_KEY` is now set in `.env.local` (added mid-session) but `openRouterModel` is currently unused in the actual request flow
- Dev testing repeatedly hit real rate limits from the assistant's own test traffic during this session — be mindful of burning quota with repeated curl tests; prefer single clean attempts over rapid retries, which compound the problem
