# Research Agent

A streaming conversational research agent: tool-calling, per-session memory, and a live reasoning trace, built on LangChain's `createAgent` (LangGraph-backed) over OpenAI, with Groq, Supabase, and Tavily filling in the rest.

## What it does 

* **Three tools**: `knowledge_base_search` (Supabase, `ILIKE` substring match), `web_search` (Tavily, capped at 3 searches per turn — enforced in code, not just prompted), `calculator` (a hand-written recursive-descent expression parser — deliberately not `eval`/`Function`, since the input is model-generated from user text)
* **Streams the answer token-by-token**, with a reasoning trace (every tool call and result, with real arguments) carried in the same response, delimited — no second call that could disagree with what the user saw
* **A reasoning dialog**, not an inline expander: a bottom sheet on phones, a centred dialog on desktop, with focus trapping, Escape-to-close, and a "copy all" for the whole trace
* **Two-tier memory**: the visible transcript persists to `localStorage` (survives a reload), and a separate running summary persists to Supabase per session (survives a new tab / device) — the two are linked by the same `sessionId` so the agent's memory and the screen never disagree
* **A model fallback chain** with a cooldown cache: a rate-limited or malformed-tool-call model is skipped on the next request without waiting to rediscover the failure, and a run that finishes with no visible answer automatically retries on the next model
* **A staged waiting indicator**: dots alone, then a status label after a delay, escalating the longer it takes — and immediately overridden by a real status (e.g. a model fallback in progress)
* **Clear conversation**: wipes the Supabase memory row, the visible transcript, and local storage together; disabled (not just inert) when there's nothing to clear

## Architecture

```
Browser (app/page.tsx)
  │  POST /api/agent  { message, sessionId }
  ▼
app/api/agent/route.ts
  │  1. loads the running summary for sessionId from Supabase
  │  2. runs createAgent (LangGraph) with 3 tools + the system prompt
  │  3. streams answer text to the client as it's generated
  │  4. on failure (rate limit / malformed tool call), retries on the
  │     next model in the chain — unless text has already streamed
  │  5. appends a delimiter, then the full reasoning trace as JSON
  │  6. summarizes the exchange (Groq) and saves it back to Supabase
  ▼
Response body: <answer text>\n__REASONING_TRACE__\n<JSON array>

```

Model chain (`lib/models.ts`): **`gpt-5-mini`** (primary) → **`gpt-5`** (fallback), OpenAI, paid. Both are reasoning models forced to `reasoning: { effort: "minimal" }` — at OpenAI's default effort, hidden reasoning tokens can consume the entire output budget and leave zero visible answer; this was caught in testing and fixed, see `HANDOFF.md`. The conversation-summary call stays on Groq (`openai/gpt-oss-20b`) — it's a small, low-stakes task with no reason to spend paid tokens on it.

## Stack

Next.js (App Router, Turbopack), TypeScript, Tailwind CSS 4, LangChain / LangGraph, OpenAI, Groq, Supabase, Tavily, `react-markdown`.

## Getting started

### 1. Environment variables

Create `.env.local`:

```bash
OPENAI_API_KEY=        # main agent (gpt-5-mini / gpt-5)
GROQ_API_KEY=          # conversation-summary model only
TAVILY_API_KEY=        # web_search tool
SUPABASE_URL=
SUPABASE_ANON_KEY=

# Optional
LANGSMITH_TRACING=true
LANGSMITH_API_KEY=
LANGSMITH_PROJECT=

```

### 2. Supabase tables

Two tables, no migrations checked in — create them directly:

**`agent_memory`** — one row per session

| column | type |
| --- | --- |
| `session_id` | `text`, primary key |
| `summary` | `text` |
| `updated_at` | `timestamptz` |

**`knowledge_base`** — seed with whatever the agent should know (LangChain / Supabase / n8n / CRM facts in this project's case)

| column | type |
| --- | --- |
| `topic` | `text` |
| `content` | `text` |

### 3. Run it

```bash
npm install
npm run dev

```

## Scripts

| command | what it does |
| --- | --- |
| `npm run dev` | dev server |
| `npm run build` / `npm run start` | production build / serve |
| `npm run lint` | ESLint |
| `npm run test:tokens` | measures real per-layer prompt token cost against the live model — see `scripts/README.md` |
| `npm run test:load` | load-tests `/api/agent` (`smoke` / `burst` / `convo` / `soak` modes) — see `scripts/README.md` |

`scripts/` also has two standalone probes (not npm-scripted, run with `node scripts/<file>.mjs`): `probe-openai-models.mjs` (verifies a model handles the real tool schemas both for tool-calling and for answering after a tool result, before it's trusted in the fallback chain) and `diagnose-tool-args.mjs` (dumps the raw streaming chunks LangChain emits for a tool call — the evidence behind the trace's argument-capture logic in `route.ts`). Both hit real, paid APIs.

## Security

* Calculator never touches `eval`/`Function` on model-generated input: a recursive-descent parser that can only ever produce a number
* The knowledge-base tool escapes PostgREST `.or()` metacharacters before interpolating user-derived text into the filter string
* Request body validated (JSON shape, message length cap, session-id pattern) before it reaches the agent
* **Not yet done**: no auth or per-IP rate limiting on the API routes — fine for a demo, not for public traffic. `sessionId` is client-generated and unauthenticated, so anyone who has it can read or clear that session's memory.

## Known limitations

* `knowledge_base_search` is `ILIKE` substring matching, not semantic search; it misses paraphrased queries that don't share a substring with the stored `topic`/`content`.
* Conversation memory is a single rolling summary, not full history: a long enough conversation with several dense, unrelated topics will eventually push earlier facts out, even with headroom.
* No auth/rate-limiting (see Security, above).

## Further reading

* `HANDOFF.md`: the working log detailing what's uncommitted, what broke and how it was fixed, along with the measurements behind each decision.
* `scripts/README.md`: how to read the token-audit and load-test output.
* `public/hardening-report.html`: a standalone write-up of an earlier rate-limit and security hardening pass.