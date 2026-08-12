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
