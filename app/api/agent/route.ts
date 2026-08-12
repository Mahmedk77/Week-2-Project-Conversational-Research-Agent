import { groqModel, groqSummaryModel, supabase, tavilyClient } from "@/lib/models";
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

function formatRateLimitMessage(retryAfterMs: number | undefined): string {
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
    description: "Evaluates a math expression using + - * / and parentheses. Example: {\"expression\": \"34 * 0.15\"}",
    schema: z.object({ expression: z.string() }),
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
        description: "Search the internal knowledge base for facts about LangChain, Supabase, n8n, and CRMs. Example: {\"query\": \"pgvector\"}",
        schema: z.object({ query: z.string() }),
    }
);

const tavily_searchTool = tool(
    async ({ query, maxResults, recencyDays }) => {
        try {
            const tavily_res = await tavilyClient.search(query, {
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
        description: "Search the web for current or real-time information. Example: {\"query\": \"latest LangChain version\"}",
        schema: z.object({
            query: z.string(),
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
- Output is hard-capped at ~500 tokens and gets cut off mid-sentence. Answer the core question first, in full, before any extra detail.
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

    const agent = createAgent({
        model: groqModel,
        tools,
        systemPrompt: SYSTEM_PROMPT
    });

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
        async start(controller) {
            try {
                let fullAnswer = "";
                const userContent = currentSummary
                    ? `[Context from earlier in this conversation: ${currentSummary}]\n\n${trimmedMessage}`
                    : trimmedMessage;
                const eventStream = await agent.stream(
                    {
                        messages: [{ role: "user" as const, content: userContent }],
                    },
                    { recursionLimit: 15, streamMode: "messages" }
                );
                const reasoningTrace: ReasoningStep[] = [];

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
                        controller.enqueue(encoder.encode(chunk.content as string));
                    }
                }

                controller.enqueue(encoder.encode("\n__REASONING_TRACE__\n"));
                controller.enqueue(encoder.encode(JSON.stringify(reasoningTrace)));

                try {
                    const updatedSummary = await exchangeSummary(fullAnswer, trimmedMessage, currentSummary);
                    await save_memory(sessionId, updatedSummary);
                } catch (memoryErr) {
                    console.error("Memory summary/save error (non-fatal):", memoryErr);
                }

                controller.close();
            } catch (err) {
                console.error("Streaming error:", err);

                if (isRateLimitError(err)) {
                    const retryAfterMs = getRetryAfterMs(err);
                    controller.enqueue(encoder.encode(formatRateLimitMessage(retryAfterMs)));
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