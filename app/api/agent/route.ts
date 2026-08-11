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

        return JSON.stringify(data);
    },
    {
        name: "knowledge_base_search",
        description: "Search the internal knowledge base for facts about LangChain, Supabase, n8n, CRMs, and related tools. Example: {\"query\": \"pgvector\"}",
        schema: z.object({ query: z.string() }),
    }
);

const tavily_searchTool = tool(
    async ({ query }) => {
        try {
            const tavily_res = await tavilyClient.search(query, { maxResults: 3 });
            return JSON.stringify(
                tavily_res.results.map((r) => ({ title: r.title, url: r.url, snippet: r.content }))
            );
        } catch (error) {
            return `Error fetching results from web: ${(error as Error).message}`;
        }
    },
    {
        name: "web_search",
        description: "Search the web for current information. Use for real-time facts, recent events, or anything you don't already know. Example: {\"query\": \"latest LangChain version\"}",
        schema: z.object({ query: z.string() }),
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
        "You are a research assistant with three tools: (1) knowledge_base_search — an internal knowledge base covering LangChain, Supabase, n8n, and CRM topics, always check this first for anything that could be in scope; (2) web_search — for current events, real-time facts, or anything not covered by the knowledge base; (3) calculator — for any arithmetic or numeric computation, always use this instead of computing math yourself. Answer concisely based on what the tools return. Formatting rules: when presenting information in a markdown table, keep each cell to one short sentence or a few words, since tables are viewed on mobile screens and verbose cells break the layout — put longer explanations in prose before or after the table, not inside cells. When showing a calculation or its result, write it in plain text (e.g. '2400 × 0.15 = 360'), never in LaTeX notation (no \\times, \\boxed, or similar syntax)."    
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