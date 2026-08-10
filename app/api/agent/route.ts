import { groqModel, supabase, tavilyClient } from "@/lib/models";
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

const exchangeSummary = async (aiMsg: string, userMsg: string, priorSummary: string) => {
    const prompt = ChatPromptTemplate.fromMessages([
        ["system", "You summarize conversations concisely, updating a running summary with new exchanges."],
        ["user", `Existing summary: {priorSummary}

New exchange:
User: {userMsg}
Assistant: {aiMsg}

Write an updated summary incorporating the new exchange.`],
    ]);

    const chain = prompt.pipe(groqModel).pipe(new StringOutputParser());
    return await chain.invoke({ aiMsg, userMsg, priorSummary });
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
        "You are a research assistant with three tools: (1) knowledge_base_search — an internal knowledge base covering LangChain, Supabase, n8n, and CRM topics, always check this first for anything that could be in scope; (2) web_search — for current events, real-time facts, or anything not covered by the knowledge base; (3) calculator — for any arithmetic or numeric computation, always use this instead of computing math yourself. Answer concisely based on what the tools return. When presenting information in a markdown table, keep each cell to one short sentence or a few words — tables are viewed on mobile screens, so verbose cells break the layout. Put longer explanations in prose before or after the table, not inside cells."    });

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
        async start(controller) {
            try {
                let fullAnswer = "";
                const eventStream = await agent.stream(
                    {
                        messages: [
                            ...(currentSummary
                                ? [{ role: "system" as const, content: `Earlier conversation summary: ${currentSummary}` }]
                                : []),
                            { role: "user" as const, content: message },
                        ],
                    },
                    { recursionLimit: 10, streamMode: "messages" }
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

                const updatedSummary = await exchangeSummary(fullAnswer, message, currentSummary);
                await save_memory(sessionId, updatedSummary);
                controller.close();
            } catch (err) {
                console.error("Streaming error:", err);
                controller.error(err);
            }
        },
    });

    return new Response(stream, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}