import { groqModel, groqSummaryModel, supabase, tavilyClient } from "@/lib/models";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { tool } from "@langchain/core/tools";
import { AIMessageChunk, createAgent, ToolMessage } from "langchain";
import { NextResponse } from "next/server";
import { z } from "zod";

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

    return data?.summary ?? "";
};

const save_memory = async (sessionId: string, summary: string) => {
    await supabase
        .from("agent_memory")
        .upsert({ session_id: sessionId, summary, updated_at: new Date().toISOString() });
};

const MAX_SUMMARY_CHARS = 800;

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

const MAX_TOOL_SNIPPET_CHARS = 200;

function truncateSnippet(text: string): string {
    if (text.length <= MAX_TOOL_SNIPPET_CHARS) return text;
    return `${text.slice(0, MAX_TOOL_SNIPPET_CHARS).trim()}...`;
}

const calculatorTool = tool(
  async ({ expression }) => {
    if (!/^[0-9+\-*/().\s]+$/.test(expression)) {
      return "Error: invalid expression";
    }
    try {
      return String(Function(`"use strict"; return (${expression});`)());
    } catch {
      return "Error: invalid expression";
    }
  },
  {
    name: "calculator",
    description: "Evaluates a math expression. Example: {\"expression\": \"34 * 0.15\"}",
    schema: z.object({ expression: z.string() }),
  }
);

const kb_searchTool = tool(
    async ({ query }) => {
        const { data, error } = await supabase
            .from("knowledge_base")
            .select("topic, content")
            .or(`topic.ilike.%${query}%,content.ilike.%${query}%`)
            .limit(3);

        if (error) return `Failed to fetch from kb_database: ${error.message}`;
        if (!data || data.length === 0) return "Cannot match the query in the database";

        return JSON.stringify(
            data.map((row) => ({ topic: row.topic, content: truncateSnippet(row.content) }))
        );
    },
    {
        name: "knowledge_base_search",
        description: "Search the internal knowledge base for facts about LangChain, Supabase, n8n, CRMs, and related tools. Example: {\"query\": \"pgvector\"}",
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
        description: "Search the web for current information. Use for real-time facts, recent events, or anything you don't already know. Example: {\"query\": \"latest LangChain version\"}. Optionally set maxResults (default 3) to control how many results come back, and recencyDays to restrict results to the last N days (e.g. 7 for \"this week\").",
        schema: z.object({
            query: z.string(),
            maxResults: z.number().int().min(1).max(10).optional().describe("Number of results to return, default 3"),
            recencyDays: z.number().int().min(1).optional().describe("Only include results from the last N days"),
        }),
    }
);

export async function POST(request: Request) {
    const { message, sessionId } = await request.json();

    if (!message || !sessionId) {
        return NextResponse.json({ error: "message and sessionId are required" }, { status: 400 });
    }

    const tools = [kb_searchTool, tavily_searchTool, calculatorTool];
    const currentSummary = await load_memory(sessionId);

    const agent = createAgent({
        model: groqModel,
        tools,
        systemPrompt:
        `You are a research assistant with three tools: knowledge_base_search, web_search, and calculator.

DEFAULT TO USING A TOOL. Treat "answer from my own knowledge" as the exception, not the default — this is a hard rule:
- Any factual claim about LangChain, Supabase, n8n, or CRMs — you MUST call knowledge_base_search first. Never answer these from memory, even if you're confident you know the answer. Your training data can be outdated or wrong; the tool result is the source of truth.
- Any question about current events, recent news, live/real-time data, or anything you are not 100% certain is timeless general knowledge — you MUST call web_search. If in doubt, search; do not guess.
- Any request that involves specific, checkable, real-world facts — place names, opening hours, prices, schedules, travel/visa requirements, recommendations that could go stale, or anything a user could fact-check and find you wrong — you MUST call web_search for at least the key facts before answering, even if the request is phrased as "plan," "suggest," "recommend," or "help me with," not as a direct question. Example: a travel itinerary request requires web_search for real, current information about the destinations, not a synthesized answer from memory.
- Any arithmetic or numeric computation, no matter how simple — you MUST call calculator. Never compute or state a numeric result yourself.
- Skip tools ONLY for messages with nothing factual to verify: greetings, clarifying questions back to the user, opinions explicitly requested as opinions, or discussing something already established earlier in this same conversation.
- If a knowledge_base_search returns no match, then call web_search before answering — do not fall back to your own knowledge just because the internal search came up empty.
- When unsure whether a request needs a tool, call one. A wasted tool call costs less than a wrong or outdated answer stated as fact.

After using tools, answer concisely based on what they returned — do not add facts the tools didn't provide.

Your response is hard-capped at ~500 tokens (roughly 350-400 words) — anything beyond that gets cut off mid-sentence. Always answer the core question first, in full, before adding any extra detail, so a cutoff never loses the actual answer.

LENGTH DISCIPLINE for large or multi-part requests (multi-day itineraries, plans spanning several locations/topics, long comparisons, "give me everything about X"): you are running on a tight token budget, so do not write an exhaustive day-by-day or item-by-item breakdown in one response. Instead:
- Give a compact overview: for a multi-day/multi-location request, one short paragraph or a tight table summarizing the whole thing (e.g. one line per day or per location, not a paragraph each).
- Pick only the 3-5 most important or most-requested facts to expand on in prose.
- End with a brief offer to go deeper on any specific part the user wants (e.g. "Want the day-by-day breakdown for Cappadocia specifically?") rather than pre-emptively writing it all out.
- This does not apply to short, single-fact answers — those should stay exactly as direct as they already are.

Formatting rules: when presenting information in a markdown table, keep each cell to one short sentence or a few words, since tables are viewed on mobile screens and verbose cells break the layout — put longer explanations in prose before or after the table, not inside cells. When showing a calculation or its result, write it in plain text (e.g. '2400 × 0.15 = 360'), never in LaTeX notation (no \\times, \\boxed, or similar syntax).`
    });

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
        async start(controller) {
            try {
                let fullAnswer = "";
                const userContent = currentSummary
                    ? `[Context from earlier in this conversation: ${currentSummary}]\n\n${message}`
                    : message;
                const eventStream = await agent.stream(
                    {
                        messages: [{ role: "user" as const, content: userContent }],
                    },
                    { recursionLimit: 15, streamMode: "messages" }
                );
                const reasoningTrace: any[] = [];

                for await (const [chunk] of eventStream) {
                    if (chunk instanceof AIMessageChunk && chunk.tool_calls?.length) {
                        reasoningTrace.push({ type: "action", tool_calls: chunk.tool_calls });
                    }
                    if (chunk instanceof ToolMessage) {
                        reasoningTrace.push({ type: "observation", tool: chunk.name, content: chunk.content });
                    }
                    if (chunk instanceof AIMessageChunk && chunk.content) {
                        fullAnswer += chunk.content;
                        controller.enqueue(encoder.encode(chunk.content as string));
                    }
                }

                controller.enqueue(encoder.encode("\n__REASONING_TRACE__\n"));
                controller.enqueue(encoder.encode(JSON.stringify(reasoningTrace)));

                try {
                    const updatedSummary = await exchangeSummary(fullAnswer, message, currentSummary);
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