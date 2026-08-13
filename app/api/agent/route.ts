import { agentModels, groqSummaryModel, supabase, tavilyClient } from "@/lib/models";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { tool } from "@langchain/core/tools";
import { AIMessageChunk, createAgent, ToolMessage } from "langchain";
import { NextResponse } from "next/server";
import { z } from "zod";
import type { ReasoningStep } from "@/app/components/types";

// Re-sent as input on every step of the agent loop, so its real cost is
// roughly 3x this on a two-tool turn.
const MAX_SUMMARY_CHARS = 400;

const load_memory = async (sessionId: string): Promise<string> => {
    const { data, error } = await supabase
        .from("agent_memory")
        .select("summary")
        .eq("session_id", sessionId)
        .maybeSingle();

    if (error) {
        console.error("load_memory error:", error.message);
        return "";
    }

    // Enforce the cap on read as well as on write: a row written by an older
    // build (or any other client) must not be able to inflate the prompt.
    const summary = data?.summary;
    if (typeof summary !== "string") return "";
    return summary.length > MAX_SUMMARY_CHARS ? summary.slice(0, MAX_SUMMARY_CHARS) : summary;
};

const save_memory = async (sessionId: string, summary: string) => {
    await supabase
        .from("agent_memory")
        .upsert({ session_id: sessionId, summary, updated_at: new Date().toISOString() });
};

const RETRY_AFTER_PATTERN = /try again in\s+(\d+(?:\.\d+)?)\s*(ms|s|seconds?|milliseconds?)/i;

function getRetryAfterMs(err: unknown): number | undefined {
    if (typeof err !== "object" || err === null) return undefined;

    const retryAfterMs = (err as { retryAfterMs?: unknown }).retryAfterMs;
    if (typeof retryAfterMs === "number") return retryAfterMs;

    const message = (err as { message?: unknown }).message;
    if (typeof message !== "string") return undefined;

    const match = RETRY_AFTER_PATTERN.exec(message);
    if (!match) return undefined;

    const value = Number(match[1]);
    if (Number.isNaN(value)) return undefined;

    const unit = match[2].toLowerCase();
    return unit === "ms" || unit.startsWith("millisecond") ? value : value * 1000;
}

function isRateLimitError(err: unknown): boolean {
    if (typeof err !== "object" || err === null) return false;
    const name = (err as { name?: unknown }).name;
    const rateLimitType = (err as { rateLimitType?: unknown }).rateLimitType;
    const status = (err as { status?: unknown }).status;
    return (
        name === "RateLimitQuotaExhaustedError" ||
        name === "RateLimitCapacityError" ||
        rateLimitType !== undefined ||
        status === 429
    );
}

/**
 * Groq reports per-minute (TPM) and per-day (TPD) exhaustion through the same
 * 429, and quotes a short "try again in Ns" hint for both. That hint is
 * actively misleading for a daily cap — you cannot recover a day's tokens in a
 * minute — so detect which limit was hit and word the message accordingly.
 */
function isDailyLimitError(err: unknown): boolean {
    const message = (err as { message?: unknown } | null)?.message;
    return typeof message === "string" && /tokens per day|\bTPD\b|requests per day|\bRPD\b/i.test(message);
}

/**
 * Malformed tool-call JSON. Direct probing of the Groq API showed the models
 * themselves emit valid arguments (15/15 clean), so this surfaces from the
 * streaming reassembly path — a tool call whose arguments were truncated or
 * split badly across SSE chunks. That makes it a transient, model-independent
 * failure, and therefore worth retrying on the next model in the chain rather
 * than failing the whole request.
 */
function isToolCallParseError(err: unknown): boolean {
    // Prefer Groq's machine-readable code: the prose has already changed three
    // times ("failed to parse tool call arguments", "tool call validation
    // failed", "the model generated output that could not be parsed") while
    // the code stayed put.
    const e = err as { code?: unknown; error?: { code?: unknown }; message?: unknown } | null;
    if (e?.code === "tool_use_failed" || e?.error?.code === "tool_use_failed") return true;

    const message = e?.message;
    return (
        typeof message === "string" &&
        /failed to parse tool call arguments|tool call validation failed|output that could not be parsed/i.test(
            message
        )
    );
}

/**
 * Rolling record of real token spend (from the models' own usage_metadata, not
 * estimates) over the last minute, so the client can be told to hold off before
 * a request fails rather than after.
 *
 * Process-local like the cooldown map: good enough to protect a single running
 * instance, not a shared source of truth across serverless workers.
 */
const TOKEN_WINDOW_MS = 60_000;
const PER_MODEL_TPM = 8000;

const tokenSpend: { at: number; tokens: number }[] = [];

function recordTokenSpend(tokens: number): void {
    if (tokens > 0) tokenSpend.push({ at: Date.now(), tokens });
}

function tokensUsedLastMinute(): number {
    const cutoff = Date.now() - TOKEN_WINDOW_MS;
    while (tokenSpend.length > 0 && tokenSpend[0].at < cutoff) tokenSpend.shift();
    return tokenSpend.reduce((sum, entry) => sum + entry.tokens, 0);
}

/**
 * What the client needs to decide whether to let the user send again.
 * `blockedForMs` is only non-zero when EVERY model is in cooldown — i.e. we
 * know the next request would fail, rather than merely suspecting it.
 */
function budgetSnapshot() {
    const cooldowns = agentModels.map(({ model }) => cooldownRemainingMs(model));
    const blockedForMs = cooldowns.every((ms) => ms > 0) ? Math.min(...cooldowns) : 0;
    return {
        usedLastMinute: tokensUsedLastMinute(),
        limit: PER_MODEL_TPM * agentModels.length,
        blockedForMs,
    };
}

/**
 * The agent hit `recursionLimit` without settling on an answer — almost always
 * the model looping on tool calls (re-searching with reworded queries instead
 * of answering from what it already has). Not retryable on another model: the
 * next one would loop the same way and burn another full budget. Handled by
 * keeping whatever was produced and telling the user plainly.
 */
function isRecursionLimitError(err: unknown): boolean {
    const name = (err as { name?: unknown } | null)?.name;
    if (name === "GraphRecursionError") return true;
    const message = (err as { message?: unknown } | null)?.message;
    return typeof message === "string" && /recursion limit of \d+ reached/i.test(message);
}

/**
 * Remembers when each model is expected to be usable again, so a request that
 * arrives during a rate-limit window skips models already known to be blocked
 * instead of spending ~8s discovering it. Without this, three exhausted models
 * cost the user ~26s of silence before any message appears.
 *
 * Best-effort only: this lives in process memory, so it is not shared across
 * serverless instances. A stale or missing entry just means we try the model
 * and find out the slow way — never a wrong answer.
 */
const modelCooldownUntil = new Map<string, number>();

/** Daily exhaustion won't clear for hours; don't retry that model soon. */
const DAILY_COOLDOWN_MS = 30 * 60 * 1000;
const DEFAULT_COOLDOWN_MS = 15 * 1000;
const MAX_COOLDOWN_MS = 60 * 60 * 1000;

function cooldownRemainingMs(model: string): number {
    const until = modelCooldownUntil.get(model);
    if (until === undefined) return 0;
    const remaining = until - Date.now();
    if (remaining <= 0) {
        modelCooldownUntil.delete(model);
        return 0;
    }
    return remaining;
}

function markModelCooldown(model: string, err: unknown): void {
    const ms = isDailyLimitError(err)
        ? DAILY_COOLDOWN_MS
        : Math.min(getRetryAfterMs(err) ?? DEFAULT_COOLDOWN_MS, MAX_COOLDOWN_MS);
    modelCooldownUntil.set(model, Date.now() + ms);
}

function formatRateLimitMessage(retryAfterMs: number | undefined, daily: boolean): string {
    if (daily) {
        return "The daily usage limit for this model has been reached. It resets on a 24-hour window — please try again later.";
    }
    if (retryAfterMs === undefined) {
        return "The model is currently rate-limited. Please try again in a moment.";
    }
    const seconds = Math.ceil(retryAfterMs / 1000);
    const unit = seconds === 1 ? "second" : "seconds";
    return `The model is currently rate-limited. Please try again in about ${seconds} ${unit}.`;
}

const exchangeSummary = async (aiMsg: string, userMsg: string, priorSummary: string) => {
    const prompt = ChatPromptTemplate.fromMessages([
        [
            "system",
            `You maintain a running summary of a conversation as plain facts, written in third person (e.g. "User asked about X; assistant explained Y").

Output ONLY the updated summary text itself — no labels, no headers, no phrases like "Existing summary:", "New exchange:", or "Updated summary:", no preamble, no explanation of what you did. Just the summary content, nothing else.

Keep the ENTIRE summary under ${MAX_SUMMARY_CHARS} characters. Prioritize the most recent and most relevant facts; compress or drop older details to stay within that limit. Be terse — no padding, no restating.`,
        ],
        ["user", `Prior summary (may be empty if this is the first exchange):
{priorSummary}

Latest exchange to fold in:
User asked: {userMsg}
Assistant answered: {aiMsg}

Reply with only the updated summary text, under ${MAX_SUMMARY_CHARS} characters.`],
    ]);

    const chain = prompt.pipe(groqSummaryModel).pipe(new StringOutputParser());
    const summary = await chain.invoke({ aiMsg, userMsg, priorSummary });
    const trimmed = summary.trim();
    return trimmed.length > MAX_SUMMARY_CHARS ? trimmed.slice(0, MAX_SUMMARY_CHARS) : trimmed;
};

/**
 * 150 was too aggressive: search snippets were being cut off inside page
 * navigation chrome ("Live Score | BROWSE BY | Estadio…") before any actual
 * fact appeared, so the model kept re-searching for information it had already
 * paid for. A useless result costs a whole extra agent step (~1.5K tokens),
 * which dwarfs the ~40 tokens saved by trimming harder.
 */
const MAX_TOOL_SNIPPET_CHARS = 350;

function truncateSnippet(text: string): string {
    if (text.length <= MAX_TOOL_SNIPPET_CHARS) return text;
    return `${text.slice(0, MAX_TOOL_SNIPPET_CHARS).trim()}...`;
}

const MAX_EXPRESSION_CHARS = 200;

/**
 * Recursive-descent evaluator for + - * / and parentheses.
 *
 * Deliberately does NOT use Function()/eval: `expression` is model-generated
 * from user text, so it is untrusted input. A charset regex in front of
 * Function() is one missed character away from arbitrary code execution, and
 * still allows things like `**` blowups. This parser can only ever produce a
 * number.
 */
function evaluateExpression(input: string): number {
    let pos = 0;

    const skipSpaces = () => {
        while (pos < input.length && /\s/.test(input[pos])) pos++;
    };

    const parseNumber = (): number => {
        skipSpaces();
        const start = pos;
        while (pos < input.length && /[0-9]/.test(input[pos])) pos++;
        if (input[pos] === ".") {
            pos++;
            while (pos < input.length && /[0-9]/.test(input[pos])) pos++;
        }
        if (pos === start) throw new Error("expected a number");
        return Number(input.slice(start, pos));
    };

    const parseFactor = (): number => {
        skipSpaces();
        if (input[pos] === "+") {
            pos++;
            return parseFactor();
        }
        if (input[pos] === "-") {
            pos++;
            return -parseFactor();
        }
        if (input[pos] === "(") {
            pos++;
            const value = parseSum();
            skipSpaces();
            if (input[pos] !== ")") throw new Error("unbalanced parentheses");
            pos++;
            return value;
        }
        return parseNumber();
    };

    const parseProduct = (): number => {
        let value = parseFactor();
        for (;;) {
            skipSpaces();
            const op = input[pos];
            if (op !== "*" && op !== "/") return value;
            pos++;
            const rhs = parseFactor();
            if (op === "/" && rhs === 0) throw new Error("division by zero");
            value = op === "*" ? value * rhs : value / rhs;
        }
    };

    const parseSum = (): number => {
        let value = parseProduct();
        for (;;) {
            skipSpaces();
            const op = input[pos];
            if (op !== "+" && op !== "-") return value;
            pos++;
            const rhs = parseProduct();
            value = op === "+" ? value + rhs : value - rhs;
        }
    };

    const result = parseSum();
    skipSpaces();
    if (pos !== input.length) throw new Error("unexpected trailing input");
    if (!Number.isFinite(result)) throw new Error("result is not a finite number");
    return result;
}

const calculatorTool = tool(
  async ({ expression }) => {
    if (expression.length > MAX_EXPRESSION_CHARS) {
      return "Error: expression too long";
    }
    try {
      return String(evaluateExpression(expression));
    } catch (err) {
      return `Error: invalid expression (${(err as Error).message})`;
    }
  },
  {
    name: "calculator",
    description: "Evaluates a math expression using + - * / and parentheses. Accepts ONLY: expression (required string). Example: {\"expression\": \"34 * 0.15\"}",
    // See web_search: unknown keys are ignored rather than crashing.
    schema: z.looseObject({ expression: z.string() }),
  }
);

const MAX_KB_QUERY_CHARS = 100;

/**
 * PostgREST's `.or()` takes a filter expression as a raw string, so any comma,
 * parenthesis, backslash or quote in an interpolated value can restructure the
 * filter tree (e.g. `a),id.gte.0,and(id.gte.0` widens the match to every row).
 * `query` comes from the model, which relays user text, so it is untrusted:
 * escape the PostgREST metacharacters and neutralise LIKE wildcards.
 */
function escapeOrFilterValue(value: string): string {
    return value
        .replace(/[\\%_]/g, "\\$&")
        .replace(/[(),."']/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

const kb_searchTool = tool(
    async ({ query }) => {
        const safeQuery = escapeOrFilterValue(query).slice(0, MAX_KB_QUERY_CHARS);
        if (!safeQuery) return "Cannot match the query in the database";

        const { data, error } = await supabase
            .from("knowledge_base")
            .select("topic, content")
            .or(`topic.ilike.%${safeQuery}%,content.ilike.%${safeQuery}%`)
            .limit(3);

        if (error) return `Failed to fetch from kb_database: ${error.message}`;
        if (!data || data.length === 0) return "Cannot match the query in the database";

        return JSON.stringify(
            data.map((row) => ({ topic: row.topic, content: truncateSnippet(row.content) }))
        );
    },
    {
        name: "knowledge_base_search",
        description: "Search the internal knowledge base for facts about LangChain, Supabase, n8n, and CRMs. Accepts ONLY: query (required string). Example: {\"query\": \"pgvector\"}",
        // See web_search: unknown keys are ignored rather than crashing.
        schema: z.looseObject({ query: z.string() }),
    }
);

/**
 * Coerce a model-supplied value to a bounded integer. The raw JSON Schema
 * below is not validated by LangChain the way a zod schema is, so the model
 * can send `"5"` or `12` where an int in range is expected — clamp rather than
 * fail, since a bad number should never cost the user their answer.
 */
function boundedInt(value: unknown, min: number, max: number): number | undefined {
    const n = typeof value === "string" ? Number(value) : value;
    if (typeof n !== "number" || !Number.isFinite(n)) return undefined;
    return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * Hard ceiling on searches per user turn.
 *
 * A prompt instruction was not enough: the model was observed making 8+
 * searches for one question, re-querying to confirm an answer it had already
 * found, and burning 23.9K tokens before running out of agent steps. This is
 * enforced in code so it cannot be ignored — once spent, the tool returns an
 * instruction to answer instead of performing another search.
 */
const MAX_SEARCHES_PER_TURN = 3;

/**
 * Built per request so the search budget is scoped to one user turn rather
 * than shared across everyone hitting the server.
 */
function createWebSearchTool() {
    let searchesUsed = 0;

    return tool(
        async (rawArgs) => {
            // Args arrive unvalidated (raw JSON Schema, see below), so read
            // them defensively instead of destructuring typed fields.
            const args = (rawArgs ?? {}) as Record<string, unknown>;
            const asText = (v: unknown) => (typeof v === "string" ? v : "");

            if (searchesUsed >= MAX_SEARCHES_PER_TURN) {
                return `Search budget spent (${MAX_SEARCHES_PER_TURN} of ${MAX_SEARCHES_PER_TURN} used). Do NOT call web_search again. Answer now from the results you already have, and state plainly anything you could not confirm.`;
            }

            // `url` is not a real search option — it exists only because the
            // model sometimes passes back a `url` it saw in earlier results
            // instead of a query. Folding it in salvages the call.
            const effectiveQuery = (asText(args.query) || asText(args.url)).trim();
            if (!effectiveQuery) {
                // Phrased as an instruction: this string goes back to the model
                // as the tool result, and is what lets it recover without a 400.
                // Deliberately does not consume budget — nothing was searched.
                return 'Error: no search terms were provided. Call web_search again with {"query": "<your search terms>"}.';
            }

            const maxResults = boundedInt(args.maxResults, 1, 10);
            const recencyDays = boundedInt(args.recencyDays, 1, 365);

            searchesUsed++;
            const remaining = MAX_SEARCHES_PER_TURN - searchesUsed;

            try {
                const tavily_res = await tavilyClient.search(effectiveQuery, {
                    maxResults: maxResults ?? 3,
                    // Tavily's own synthesised answer. Costs ~40 tokens and
                    // usually settles the question outright, which is far
                    // cheaper than the extra search it prevents.
                    includeAnswer: true,
                    ...(recencyDays !== undefined ? { days: recencyDays } : {}),
                });

                return JSON.stringify({
                    answer: tavily_res.answer ?? null,
                    results: tavily_res.results.map((r) => ({
                        title: r.title,
                        url: r.url,
                        snippet: truncateSnippet(r.content),
                    })),
                    // Told directly to the model so the ceiling is visible to
                    // it, not just enforced behind its back.
                    searchesRemaining: remaining,
                    note:
                        remaining === 0
                            ? "This was your last search. Answer now from what you have."
                            : undefined,
                });
            } catch (error) {
                return `Error fetching results from web: ${(error as Error).message}`;
            }
        },
        {
        name: "web_search",
        // The parameter list is spelled out deliberately. This tool RETURNS
        // objects containing `url`, and the model has been observed feeding
        // that back as an input, as well as inventing `topn`/`recency_days`
        // and `id`/`cursor`. Naming the accepted inputs costs ~30 tokens and
        // reduces how often that happens.
        description:
            "Search the web for current or real-time information. Accepts ONLY these parameters: query (required, a search-terms string), maxResults (optional number), recencyDays (optional number). You cannot pass a URL or fetch a specific page — describe what you want in `query` instead. Example: {\"query\": \"latest LangChain version\"}",
        /**
         * RAW JSON SCHEMA ON PURPOSE — do not "modernise" this back to zod.
         *
         * Groq validates tool calls server-side against the schema we send. A
         * zod schema (even `z.looseObject`) is converted by LangChain's
         * `convertToOpenAITool`, which hard-codes `additionalProperties: false`
         * and silently discards the looseness. The model reliably invents extra
         * keys on this tool, so every invented key became a `tool_use_failed`
         * 400 and a wasted model call.
         *
         * A raw JSON Schema object is passed through untouched, so
         * `additionalProperties: true` survives to the wire and unknown keys
         * are simply ignored. Verified against `convertToOpenAITool`.
         *
         * Trade-off: LangChain no longer parses/validates args for us, so the
         * handler above reads them defensively.
         */
        schema: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description: "Search terms, e.g. 'latest LangChain version'. Required.",
                },
                maxResults: {
                    type: "integer",
                    minimum: 1,
                    maximum: 10,
                    description: "How many results, default 3",
                },
                recencyDays: {
                    type: "integer",
                    minimum: 1,
                    description: "Only results from the last N days",
                },
            },
            // `query` is deliberately NOT in `required`. Groq enforces
            // `required` server-side and answers a violation with a 400, which
            // costs a whole model call and cannot be caught in the handler.
            // Leaving it out means a query-less call reaches the tool, which
            // returns a plain error string the model can read and correct from
            // inside the same loop — a recoverable tool result instead of a
            // failed request.
            additionalProperties: true,
        },
        }
    );
}

/**
 * Kept deliberately terse: LangGraph resends the full message history on every
 * step of the agent loop, so this prompt is re-billed as input on each LLM call
 * (~3x for a two-tool turn). Every token here costs roughly triple against the
 * 8k TPM ceiling.
 *
 * Terse but COMPLETE — each line below is a distinct behavioural rule that was
 * added in response to a real observed failure. Shorten wording freely; do not
 * drop a rule.
 */
const SYSTEM_PROMPT = `You are a research assistant with three tools: knowledge_base_search, web_search, and calculator.

TOOL USE — default to calling a tool; answering from your own knowledge is the exception:
- LangChain, Supabase, n8n, or CRM facts: MUST call knowledge_base_search first. The tool result is the source of truth, not your training data.
- Current events, recent news, live data, or anything not timeless general knowledge: MUST call web_search.
- Specific checkable real-world facts (places, hours, prices, schedules, travel/visa rules, anything that goes stale): MUST call web_search first, including when phrased as "plan"/"suggest"/"recommend" rather than a question. A travel itinerary requires web_search.
- Any arithmetic, however simple: MUST call calculator. Never compute a number yourself.
- If knowledge_base_search returns no match, call web_search before answering.
- Skip tools ONLY for: greetings, clarifying questions, opinions asked for as opinions, or things already established earlier in this conversation.
- When unsure, call a tool. A wasted call beats a wrong fact.
- web_search is HARD-LIMITED to 3 searches per question and each result tells you how many remain. Make them count: one well-chosen query beats three narrow ones. Never repeat a search with reworded terms, never search to double-check something a result already told you, and never search again just because a snippet looked thin — say plainly what you could not confirm instead. Each result may include an "answer" field; if it answers the question, use it and stop searching.
- Once searches are spent, or you have enough to respond, answer immediately. Running out of steps means the user gets nothing, which is worse than a partial answer.

ANSWERING:
- Use only what the tools returned; add no facts they didn't provide.
- Output is hard-capped at ~800 tokens and gets cut off mid-sentence. Answer the core question first, in full, before any extra detail.
- Large/multi-part requests (multi-day itineraries, multi-topic plans, long comparisons, "everything about X"): give a compact overview — one line per day/location, or a tight table — not a paragraph each. Expand only the 3-5 most important points, then offer to go deeper on one part instead of pre-writing it all. Short single-fact answers stay direct.

FORMATTING:
- Table cells: one short sentence or a few words (mobile screens); put longer explanation in prose outside the table.
- Write calculations in plain text ('2400 × 0.15 = 360'), never LaTeX (no \\times, \\boxed).`;

/**
 * A single user message is unbounded input that goes straight into the model's
 * context, so it is both an abuse vector and the largest single contributor to
 * per-request input tokens (the 8k TPM ceiling). Cap it at the source.
 */
const MAX_MESSAGE_CHARS = 4000;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Transient progress frames, so a slow fallback doesn't look like a hung app.
 * Wrapped in RS (0x1E) control characters, which can never appear in model
 * output or JSON text, so the client can strip them from the visible answer
 * without risk of eating real content.
 */
const STATUS_SENTINEL = "\x1e";
const statusFrame = (text: string) => `${STATUS_SENTINEL}${text}${STATUS_SENTINEL}`;

/**
 * Max agent steps per turn. One tool call costs two steps (model decides, tool
 * runs), so this allows roughly 7 tool calls. Raising it does not fix a looping
 * model — it just lets the loop burn more of the token budget before stopping.
 * The real guard is the tool-call ceiling in SYSTEM_PROMPT.
 */
const RECURSION_LIMIT = 15;

export async function POST(request: Request) {
    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const { message, sessionId } = (body ?? {}) as { message?: unknown; sessionId?: unknown };

    if (typeof message !== "string" || typeof sessionId !== "string") {
        return NextResponse.json({ error: "message and sessionId are required" }, { status: 400 });
    }

    const trimmedMessage = message.trim();
    if (!trimmedMessage) {
        return NextResponse.json({ error: "message and sessionId are required" }, { status: 400 });
    }
    if (trimmedMessage.length > MAX_MESSAGE_CHARS) {
        return NextResponse.json(
            { error: `message must be ${MAX_MESSAGE_CHARS} characters or fewer` },
            { status: 400 }
        );
    }
    if (!SESSION_ID_PATTERN.test(sessionId)) {
        return NextResponse.json({ error: "sessionId is malformed" }, { status: 400 });
    }

    // web_search carries a per-turn search budget, so it must be built fresh
    // for each request rather than shared at module scope.
    const tools = [kb_searchTool, createWebSearchTool(), calculatorTool];
    const currentSummary = await load_memory(sessionId);

    const userContent = currentSummary
        ? `[Context from earlier in this conversation: ${currentSummary}]\n\n${trimmedMessage}`
        : trimmedMessage;

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
        async start(controller) {
            /**
             * Runs the agent on one model. Streams answer text straight to the
             * client as it arrives, so `emitted` tells the caller whether
             * anything has reached the user — once it has, we must not restart
             * on another model or the response would be duplicated.
             */
            const runWithModel = async (instance: (typeof agentModels)[number]["instance"]) => {
                const agent = createAgent({ model: instance, tools, systemPrompt: SYSTEM_PROMPT });
                const reasoningTrace: ReasoningStep[] = [];
                let fullAnswer = "";
                let emitted = false;

                const eventStream = await agent.stream(
                    { messages: [{ role: "user" as const, content: userContent }] },
                    { recursionLimit: RECURSION_LIMIT, streamMode: "messages" }
                );

                let exhaustedSteps = false;
                try {
                    for await (const [chunk] of eventStream) {
                        if (chunk instanceof AIMessageChunk && chunk.tool_calls?.length) {
                            reasoningTrace.push({
                                type: "action",
                                tool_calls: chunk.tool_calls.map((call) => ({
                                    name: call.name,
                                    args: call.args,
                                })),
                            });
                        }
                        if (chunk instanceof ToolMessage) {
                            reasoningTrace.push({
                                type: "observation",
                                tool: chunk.name ?? "unknown",
                                content: String(chunk.content),
                            });
                        }
                        if (chunk instanceof AIMessageChunk && chunk.usage_metadata) {
                            // Real spend for this step, reported by the model.
                            // Every loop step contributes, so this sums the
                            // whole turn rather than just the final call.
                            recordTokenSpend(chunk.usage_metadata.total_tokens ?? 0);
                        }
                        if (chunk instanceof AIMessageChunk && chunk.content) {
                            fullAnswer += chunk.content;
                            emitted = true;
                            controller.enqueue(encoder.encode(chunk.content as string));
                        }
                    }
                } catch (err) {
                    // A step-budget exhaustion is not a lost request: the tool
                    // results and any partial text are still worth returning,
                    // so swallow it here instead of discarding the whole run.
                    if (!isRecursionLimitError(err)) throw err;
                    console.warn(`Recursion limit hit after ${reasoningTrace.length} steps`);
                    exhaustedSteps = true;
                }

                return { fullAnswer, reasoningTrace, emitted, exhaustedSteps };
            };

            let emittedAny = false;
            let lastRetryableError: unknown;

            const sendStatus = (text: string) => {
                if (!emittedAny) controller.enqueue(encoder.encode(statusFrame(text)));
            };

            /**
             * Budget travels in the same control-frame channel as status text.
             * A frame whose payload starts with `{` is metadata, not something
             * to display — the client branches on that.
             */
            const sendBudget = () => {
                controller.enqueue(encoder.encode(statusFrame(JSON.stringify(budgetSnapshot()))));
            };

            try {
                // If every model is already known to be rate-limited, say so now
                // rather than spending ~8s per model rediscovering it.
                const allCooling = agentModels.every(({ model }) => cooldownRemainingMs(model) > 0);
                if (allCooling) {
                    const soonestMs = Math.min(
                        ...agentModels.map(({ model }) => cooldownRemainingMs(model))
                    );
                    const daily = soonestMs > DEFAULT_COOLDOWN_MS * 10;
                    controller.enqueue(encoder.encode(formatRateLimitMessage(soonestMs, daily)));
                    sendBudget();
                    controller.enqueue(encoder.encode("\n__REASONING_TRACE__\n"));
                    controller.enqueue(encoder.encode("[]"));
                    controller.close();
                    return;
                }

                let attempt = 0;
                for (let i = 0; i < agentModels.length; i++) {
                    const { model, instance } = agentModels[i];

                    // Skip models we already know are blocked.
                    if (cooldownRemainingMs(model) > 0) {
                        console.warn(`Skipping ${model}, cooling down for ${Math.ceil(cooldownRemainingMs(model) / 1000)}s`);
                        continue;
                    }

                    attempt++;
                    sendStatus(attempt === 1 ? "Thinking…" : "Model busy: trying a backup…");

                    try {
                        const { fullAnswer, reasoningTrace, emitted, exhaustedSteps } =
                            await runWithModel(instance);

                        // A run that finishes without producing any answer text
                        // is a failure, not a success — some models complete the
                        // tool call then return zero content. Treat it like any
                        // other retryable fault so the next model gets a turn.
                        // Step exhaustion is excluded: another model would loop
                        // the same way and burn a second budget for nothing.
                        if (!emitted && !fullAnswer.trim() && !exhaustedSteps && i + 1 < agentModels.length) {
                            console.warn(`Model ${model} returned an empty answer, falling back to ${agentModels[i + 1].model}`);
                            lastRetryableError = new Error(`${model} returned no content`);
                            continue;
                        }

                        emittedAny ||= emitted;

                        if (exhaustedSteps) {
                            // Kept whatever was produced; explain the stop so a
                            // truncated answer doesn't look like a glitch.
                            const note = fullAnswer.trim()
                                ? "\n\n_(Stopped early — this question needed more research steps than allowed. Ask about one part at a time for a fuller answer.)_"
                                : "That question needed more research steps than allowed. Try narrowing it — ask about one part at a time.";
                            controller.enqueue(encoder.encode(note));
                        } else if (!emitted && !fullAnswer.trim()) {
                            // Last model in the chain and still nothing to show:
                            // say so rather than rendering an empty bubble.
                            controller.enqueue(
                                encoder.encode("The model didn't return an answer for that. Please try again.")
                            );
                        }

                        sendBudget();
                        controller.enqueue(encoder.encode("\n__REASONING_TRACE__\n"));
                        controller.enqueue(encoder.encode(JSON.stringify(reasoningTrace)));

                        try {
                            const updatedSummary = await exchangeSummary(
                                fullAnswer,
                                trimmedMessage,
                                currentSummary
                            );
                            await save_memory(sessionId, updatedSummary);
                        } catch (memoryErr) {
                            console.error("Memory summary/save error (non-fatal):", memoryErr);
                        }

                        controller.close();
                        return;
                    } catch (err) {
                        // Retry on another model only for failures that are
                        // transient or model-specific — rate limits and broken
                        // tool-call JSON. Everything else (a genuine bug, a
                        // Supabase outage) fails fast. And never retry after
                        // text has reached the client: restarting mid-stream
                        // would duplicate the visible answer.
                        const rateLimited = isRateLimitError(err);
                        const parseFailure = isToolCallParseError(err);
                        if (!rateLimited && !parseFailure) throw err;

                        // Remember the block so the NEXT request skips this
                        // model instead of waiting to rediscover it.
                        if (rateLimited) markModelCooldown(model, err);

                        lastRetryableError = err;

                        console.warn(
                            `Model ${model} failed (${rateLimited ? "rate limit" : "tool-call parse"})${
                                i + 1 < agentModels.length ? `, falling back to ${agentModels[i + 1].model}` : ""
                            }`
                        );

                        if (emittedAny) throw err;
                    }
                }

                // Every model in the chain failed. Report the cause of the LAST
                // failure, not any rate limit seen earlier in the chain — a
                // stale 429 from model 1 must not be reported when model 3
                // actually died of a parse error.
                const notice = isRateLimitError(lastRetryableError)
                    ? formatRateLimitMessage(
                          getRetryAfterMs(lastRetryableError),
                          isDailyLimitError(lastRetryableError)
                      )
                    : "The model had trouble completing that request. Please try again.";
                console.error("All models failed; last error:", lastRetryableError);
                controller.enqueue(encoder.encode(notice));
                sendBudget();
                controller.enqueue(encoder.encode("\n__REASONING_TRACE__\n"));
                controller.enqueue(encoder.encode("[]"));
                controller.close();
            } catch (err) {
                console.error("Streaming error:", err);

                if (isRateLimitError(err) || isToolCallParseError(err)) {
                    // Mid-stream (emittedAny) we cannot switch models without
                    // duplicating the visible answer, so keep what was already
                    // shown and append the notice instead of discarding it.
                    const notice = isRateLimitError(err)
                        ? formatRateLimitMessage(getRetryAfterMs(err), isDailyLimitError(err))
                        : "The model had trouble completing that request. Please try again.";
                    controller.enqueue(encoder.encode(emittedAny ? `\n\n${notice}` : notice));
                    sendBudget();
                    controller.enqueue(encoder.encode("\n__REASONING_TRACE__\n"));
                    controller.enqueue(encoder.encode("[]"));
                    controller.close();
                    return;
                }

                controller.error(err);
            }
        },
    });

    return new Response(stream, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}