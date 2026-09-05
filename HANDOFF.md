# Handoff — Week 2 Research Agent

Short-form status for starting a new conversation. Full technical detail lives in `CONVERSATION_SUMMARY.md` and `public/hardening-report.html`.

## Uncommitted right now

- `lib/models.ts` — modified, not committed
- `app/api/agent/route.ts` — modified, not committed (`MAX_SUMMARY_CHARS` 400→1200, and `~1500`→`~3000` in the output-length instruction to stay in sync with `MAX_OUTPUT_TOKENS`)
- `app/globals.css`, `app/page.tsx`, `app/components/*` — the UI pass described at the bottom
- `app/favicon.ico`, `app/apple-icon.png` — black frame removed, cream card only
- `public/hardening-report.html` — new, not committed
- `scripts/probe-openai-models.mjs` — new, not committed (the probe tool described below)

## OpenAI migration — DONE, verified live

Main agent chain (`AGENT_MODEL_CHAIN` in `lib/models.ts`) is `gpt-5-mini` (primary) → `gpt-5` (fallback) on OpenAI's paid API — mini first deliberately, per user request, since it's materially cheaper and this workload (tool orchestration + moderate-length answers) doesn't need gpt-5's extra capability day to day; gpt-5 stays only as a fallback for an outage/rate limit on mini. `OPENAI_API_KEY` is in `.env.local`. Verified end-to-end against the real running app (`npm run dev`, real `curl` calls to `/api/agent`, real Tavily/Supabase calls) — tool-calling, streaming, and memory all confirmed working with real output, including a direct check that `gpt-5-mini` serves requests on the first attempt (no fallback triggered).

**Bug caught and fixed during verification — gpt-5 returned BLANK answers:**
Probed both models the same way every Groq model was probed (`scripts/probe-openai-models.mjs` — real tool schemas, real search-budget-exhausted state, both tool-calling and post-tool-answering halves of the loop). At OpenAI's default reasoning effort, `gpt-5` returned **zero visible content in 3/3 attempts** after a tool call — `finish_reason: "length"`, all 1500 tokens of `MAX_OUTPUT_TOKENS` spent on hidden reasoning tokens, none left for the answer. Same "tool ran, answer blank" symptom as the old `gpt-oss-120b` bug, different mechanism (reasoning-token budget exhaustion, not a broken model). `gpt-5-mini` was flaky the same way (1/3 blank).

Fixed in `lib/models.ts`:
- `reasoning: { effort: "minimal" }` added to `openAIChatModel()` — took gpt-5 to 3/3 clean (0 reasoning tokens, 4200-4600 char answers).
- `MAX_OUTPUT_TOKENS` raised 1500 → 3000 — gpt-5-mini still occasionally spends a few hundred reasoning tokens even at "minimal" effort; re-probed at 3000 and got 5/5 clean. Ceiling only, doesn't inflate typical-turn cost.
- `SYSTEM_PROMPT` in `route.ts` updated to say "~3000 tokens" to match (the model is told this number — keep them in sync per the existing comment convention).

**Bug found and fixed, unrelated to OpenAI — Groq removed `llama-3.1-8b-instant`:**
While testing live, every turn logged `Memory summary/save error (non-fatal): 404 model_not_found` for `llama-3.1-8b-instant` — Groq has deleted that model from the account entirely (confirmed via `GET https://api.groq.com/openai/v1/models`; only `gpt-oss-*`, `qwen3.x`, `compound*` remain). Memory summarization was silently no-op-ing on every turn. Switched `groqSummaryModel` to `openai/gpt-oss-20b` (the project's own previously-verified-reliable Groq model, see `CONVERSATION_SUMMARY.md`'s probe table) and re-probed it against the actual summarization prompt: 3/3 clean, no leaked labels, under the 400-char cap. Re-verified live: summary now saves to Supabase correctly.

**Still not empirically verified (lower risk, documented reasoning only):**
Rate-limit detection regexes (`isDailyLimitError`, retry-after parser in `route.ts`) were tuned to Groq's exact error wording and not deliberately re-triggered against a real OpenAI 429 (would mean deliberately burning paid quota). `RETRY_AFTER_PATTERN`'s "try again in Nms" wording matches OpenAI's documented 429 format, and `status === 429` check is provider-agnostic, so this should carry over. `isDailyLimitError`'s "tokens per day / TPD / RPD" match is Groq-specific phrasing that OpenAI's paid tier doesn't use the same way — on OpenAI this will just always resolve to the per-minute `DEFAULT_COOLDOWN_MS`/retry-after path rather than the 30-minute daily cooldown, which is the correct behavior for a paid account without Groq-style free-tier daily buckets. Revisit only if real OpenAI 429s are observed behaving differently than expected.

`PER_MODEL_TPM = 8000` in `route.ts` is a leftover Groq free-tier constant used only to compute `usedLastMinute`/`limit` in `budgetSnapshot()` — traced through to the frontend (`app/page.tsx`) and confirmed **neither value is actually rendered**, only `blockedForMs` is (which comes from real per-model cooldowns set by actual 429s, not from this constant). Harmless dead data on OpenAI; not worth touching unless that UI changes.

**Bug found via manual testing — memory dropped the first topic after 2 topic switches:**
User ran 3 dense, unrelated questions in one session (Turkey itinerary → Tokyo visa/flights → SaaS churn math), then asked "what was the first thing I asked you?" — the agent confidently answered with the churn topic, and a follow-up asking specifically about Turkey got "no record of you asking about that." Traced via LangSmith + the raw Supabase `agent_memory` row: `MAX_SUMMARY_CHARS` was 400 (cut from 800 during the Groq-only hardening work, to protect Groq's shared TPM bucket back when the *main* agent was also on Groq and resent this summary 3x/loop — see the long comment on `MAX_SUMMARY_CHARS` in `route.ts`). At 400 chars, the summarizer's own prompt instruction ("prioritize the most recent... drop older details") forced it to fully erase turn 1 to fit turn 3, so the main agent's only memory of the conversation no longer contained Turkey at all — not a hallucination, it genuinely wasn't there. Worse, the wrong answer to "what was first" then got folded into the NEXT summary, entrenching the error.

Fixed: `MAX_SUMMARY_CHARS` raised 400 → 1200 (that reasoning mostly stopped applying once the main chain moved to paid OpenAI; only the summarizer call itself still touches Groq, once per turn). Re-ran the exact same 4-turn sequence live: final summary was 1116/1200 chars and retained all three topics, "what was the first thing" correctly answered Turkey. This doesn't eliminate the underlying limitation of a single rolling summary (a conversation dense enough will eventually still evict old facts) — it just raises the bar substantially. `agent_memory.summary` in Supabase is `text` (unbounded), so no schema change needed if this ever needs to go higher.

## Everything else this session (all committed, all verified)

- **Root cause of rate limits**: not search results (11% of budget) — the system prompt (55%), because LangGraph resends full history every loop step. Compressed 3,619→1,900 chars, all 20 behavioral rules verified intact.
- **Model selection**: every candidate probed on both halves of the loop (tool-calling AND answering after a tool). Caught a model that passed one and failed the other in production.
- **Fallback chain + cooldown cache**: rate-limit response time 26s → ~350ms.
- **6 security fixes**: RCE in calculator (model output hit `Function()`), SQL/PostgREST injection, input validation gaps.
- **UI**: progress indicator during long waits, input locks during rate limits with countdown, mobile layout fixed (360px/390px verified), output cap raised 800→1500 tokens (was truncating mid-word).
- **Known open items**: no auth/rate-limiting on the API routes (fine for a demo, not for public traffic), occasional LaTeX leak in markdown (cosmetic), search-budget-resets-per-attempt edge case in the fallback chain (diagnosed, not fixed — narrow trigger, user chose to hold).

## UI pass (uncommitted, verified in a real browser)

Taken as inspiration from a reference project, rebuilt in this app's own warm-neutral language rather than copied (no borrowed accent colour — filled controls stay `text-primary`).

- **Three text tokens replace one colour at N opacities**: `--text-primary: #2b2521`, `--text-secondary: #6f645b`, `--text-muted: #9a8f84`. Opacity-derived greys drift blue over a warm page; these stay in the warm family. Added `--surface-card: #fffdfa` so bordered cards lift off the page without a shadow. All `text-primary/NN` usages across the components were replaced with the semantic token.
- **Reasoning trace is now a dialog**, not an inline expander — a bottom sheet on phones, a centred dialog from `sm` up (one component, motion switched in CSS since Tailwind can't vary the `animation` shorthand per breakpoint). Portalled to `document.body`, with Escape-to-close, a Tab focus trap, focus restore on close, backdrop click, and body scroll lock (the transcript scrolls at document level, so without the lock the sheet drags the page under it). Trigger is a pill in the message's action row: `View reasoning (N)` plus a muted `Used web_search` summary that hides on small screens.
- **Observation rendering got materially better**: tool results were being dumped as flattened raw JSON. `summarizeObservation` now walks the payload and leads with Tavily's own `answer` field, so a step reads as a sentence rather than a JSON smear.
- **Message bubbles**: user messages are a right-aligned filled bubble with an inline timestamp (`createdAt` added to `ChatMessage`, display-only, safe from hydration mismatch because the transcript always starts empty) and a desktop-only avatar; assistant messages are a bordered card with the bot avatar chip alongside and copy/retry/reasoning in a divider-separated action row inside the card.
- **`Clear conversation`** (renamed from "Clear memory") is disabled — muted text, faded border, `cursor-not-allowed` — while there is nothing to clear, or while streaming.

Verified by driving the real app in Chrome via Playwright (installed with `--no-save` and removed afterwards; `package.json`/lockfile untouched) at 1280px and 390px, with real API/Tavily/Supabase calls, then deleting the smoke-test memory rows.

**Gap this surfaced — now FIXED:** tool-call arguments never reached the trace (every action step was `args: {}`), so the dialog's "tool call" cards showed only a tool name. See the next section.

## Tool arguments in the reasoning trace (fixed, verified live)

The model does not send a tool call whole — it streams the arguments as a JSON string split across many chunks. Captured from the real stream (`scripts/diagnose-tool-args.mjs`, kept as the evidence and as a regression check if a LangChain bump changes the chunk shape):

- the **announcement** chunk is the only one where `chunk.tool_calls` is non-empty, and it carries the name and id with `args: ""` — nothing has arrived yet;
- every following chunk has `tool_calls: []` and puts one fragment in `tool_call_chunks` (`{"`, `expression`, `":"`, `34`, ` *`, …).

`route.ts` recorded a step only when `tool_calls` was non-empty, i.e. exactly the one chunk guaranteed to have no arguments, and skipped every chunk that actually carried them. Purely a recording bug — LangChain reassembles the fragments internally before running the tool, which is why answers were always correct.

Fix, in the streaming loop: `openToolArgs` maps a tool call's stream slot (`index`) to the trace object already pushed, plus a raw string buffer. Fragments append to the buffer; once it parses as a complete JSON object the arguments are written back into that same object. Deliberate choices worth keeping:

- The step is still pushed at the **same moment as before** (the announcement), so trace ordering — action always before its own ToolMessage — is untouched; the args are filled in by mutating that object, which is safe because the trace is serialised only once, after the loop.
- Slots are bound by **`id`, not array position**: a call whose partial args fail to parse is dropped from `tool_calls` while remaining in `tool_call_chunks`, which would shift the two lists out of step.
- `index` **restarts at 0 on every model call**, so an announcement always replaces its slot — otherwise a later tool call would append onto an earlier call's buffer.
- `tryParseToolArgs` never throws; a partial or malformed buffer just leaves the step's args as they were. A genuinely broken tool call is still handled by the existing `isToolCallParseError` fallback.

Verified against the live app: calculator → `{"expression":"34 * 12.5"}`; web_search → `{"query":"…","maxResults":3,"recencyDays":30}`; and a 6-step turn spanning `knowledge_base_search` → `web_search` → `calculator` (three separate model calls, each restarting at index 0) came back strictly alternating action/observation with correct, uncontaminated args on all three.

## Test tooling

`scripts/loadtest.mjs` (modes: smoke/burst/convo/soak) and `scripts/token-audit.mjs` — both hit live APIs and cost real tokens, documented in `scripts/README.md`.
