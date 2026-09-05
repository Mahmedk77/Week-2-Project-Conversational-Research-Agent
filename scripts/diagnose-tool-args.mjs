// Diagnostic: what do the streamed chunks actually carry for a tool call?
//
// The reasoning trace in app/api/agent/route.ts records `chunk.tool_calls`
// straight off each AIMessageChunk, and every action step comes out with
// `args: {}`. This reproduces the same stream in isolation and prints, chunk
// by chunk, what `tool_calls` and `tool_call_chunks` hold — so the cause is
// observed rather than assumed.
import fs from "node:fs";
import { ChatOpenAI } from "@langchain/openai";
import { tool } from "@langchain/core/tools";
import { AIMessageChunk, createAgent } from "langchain";
import { z } from "zod";

const env = fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const key = /OPENAI_API_KEY=(.+)/.exec(env)[1].trim();

const calculator = tool(async ({ expression }) => String(expression), {
  name: "calculator",
  description: "Evaluates a math expression. Accepts ONLY: expression (required string).",
  schema: z.looseObject({ expression: z.string() }),
});

const model = new ChatOpenAI({
  model: "gpt-5-mini",
  apiKey: key,
  maxTokens: 3000,
  reasoning: { effort: "minimal" },
});

const agent = createAgent({
  model,
  tools: [calculator],
  systemPrompt: "Any arithmetic, however simple: MUST call calculator.",
});

const stream = await agent.stream(
  { messages: [{ role: "user", content: "What is 34 * 12.5?" }] },
  { recursionLimit: 15, streamMode: "messages" }
);

let i = 0;
for await (const [chunk] of stream) {
  if (!(chunk instanceof AIMessageChunk)) continue;
  const hasToolCalls = (chunk.tool_calls ?? []).length > 0;
  const hasChunks = (chunk.tool_call_chunks ?? []).length > 0;
  if (!hasToolCalls && !hasChunks) continue;

  i++;
  console.log(`--- chunk ${i} ---`);
  console.log("  tool_calls      :", JSON.stringify(chunk.tool_calls));
  console.log("  tool_call_chunks:", JSON.stringify(chunk.tool_call_chunks));
}
console.log(`\n${i} chunk(s) carried tool-call data.`);
