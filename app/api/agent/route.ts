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
    const message = (err as { message?: unknown } | null)?.message;
    return (
        typeof message === "string" &&
        /failed to parse tool call arguments|tool call validation failed/i.test(message)
    );
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

const MAX_TOOL_SNIPPET_CHARS = 150;

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

const tavily_searchTool = tool(
    async ({ query, url, maxResults, recencyDays }) => {
        // `url` is not a real search option — it exists only because the model
        // sometimes passes back a `url` it saw in earlier results instead of a
        // query. Accepting and folding it in turns a hard schema-validation
        // crash into a usable search.
        const effectiveQuery = (query ?? url ?? "").trim();
        if (!effectiveQuery) {
            return "Error: `query` is required and must be search terms, not a URL.";
        }

        try {
            const tavily_res = await tavilyClient.search(effectiveQuery, {
                maxResults: maxResults ?? 3,
                ...(recencyDays !== undefined ? { days: recencyDays } : {}),
            });
            return JSON.stringify(
                tavily_res.results.map((r) => ({ title: r.title, url: r.url, snippet: truncateSnippet(r.content) }))
            );
        } catch (error) {
            return `Error fetching results from web: ${(error as Error).message}`;
        }
    },
    {
        name: "web_search",
        // The parameter list is spelled out deliberately. This tool RETURNS
        // objects containing `url`, and the model has been observed feeding
        // that back as an input ("additionalProperties 'url' not allowed",
        // and previously inventing `topn`/`recency_days`). Naming the only
        // three accepted inputs — and that `query` is required — costs ~30
        // tokens and prevents a hard validation crash.
        description:
            "Search the web for current or real-time information. Accepts ONLY these parameters: query (required, a search-terms string), maxResults (optional number), recencyDays (optional number). You cannot pass a URL or fetch a specific page — describe what you want in `query` instead. Example: {\"query\": \"latest LangChain version\"}",
        // looseObject is load-bearing. The model has now invented three
        // different extra parameters across traces (`topn`/`recency_days`,
        // then `url`, then `id`/`cursor`), and each one was a hard crash
        // because a strict object sets additionalProperties:false in the
        // generated JSON Schema. Denying unknown keys one at a time is
        // unwinnable; accepting and ignoring them costs nothing, since only
        // the four fields below are ever read.
        schema: z.looseObject({
            query: z.string().optional().describe("Search terms, e.g. 'latest LangChain version'. Required."),
            // Tolerated, not advertised: the tool returns objects containing
            // `url`, and the model sometimes echoes one back as input.
            url: z.string().optional(),
            maxResults: z.number().int().min(1).max(10).optional().describe("How many results, default 3"),
            recencyDays: z.number().int().min(1).optional().describe("Only results from the last N days"),
        }),
    }
);

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

    const tools = [kb_searchTool, tavily_searchTool, calculatorTool];
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
                    { recursionLimit: 15, streamMode: "messages" }
                );

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
                    if (chunk instanceof AIMessageChunk && chunk.content) {
                        fullAnswer += chunk.content;
                        emitted = true;
                        controller.enqueue(encoder.encode(chunk.content as string));
                    }
                }

                return { fullAnswer, reasoningTrace, emitted };
            };

            let emittedAny = false;
            let lastRetryableError: unknown;

            try {
                for (let i = 0; i < agentModels.length; i++) {
                    const { model, instance } = agentModels[i];
                    try {
                        const { fullAnswer, reasoningTrace, emitted } = await runWithModel(instance);

                        // A run that finishes without producing any answer text
                        // is a failure, not a success — some models complete the
                        // tool call then return zero content. Treat it like any
                        // other retryable fault so the next model gets a turn.
                        if (!emitted && !fullAnswer.trim() && i + 1 < agentModels.length) {
                            console.warn(`Model ${model} returned an empty answer, falling back to ${agentModels[i + 1].model}`);
                            lastRetryableError = new Error(`${model} returned no content`);
                            continue;
                        }

                        emittedAny ||= emitted;

                        // Last model in the chain and still nothing to show:
                        // say so rather than rendering an empty bubble.
                        if (!emitted && !fullAnswer.trim()) {
                            controller.enqueue(
                                encoder.encode("The model didn't return an answer for that. Please try again.")
                            );
                        }

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