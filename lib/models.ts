import { ChatOpenAI } from "@langchain/openai";
import { createClient } from "@supabase/supabase-js";
import { tavily } from "@tavily/core";

export const groqModel = new ChatOpenAI({
  model: "openai/gpt-oss-20b",
  apiKey: process.env.GROQ_API_KEY,
  maxTokens: 500,
  configuration: {
    baseURL: "https://api.groq.com/openai/v1",
  },
});

export const groqSummaryModel = new ChatOpenAI({
  model: "llama-3.1-8b-instant",
  apiKey: process.env.GROQ_API_KEY,
  configuration: {
    baseURL: "https://api.groq.com/openai/v1",
  },
});

export const openRouterModel = new ChatOpenAI({
  model: "inclusionai/ling-3.0-tiny:free",
  apiKey: process.env.OPENROUTER_API_KEY,
  configuration: {
    baseURL: "https://openrouter.ai/api/v1",
  },
});

export const tavilyClient  = tavily({ 
  apiKey: process.env.TAVILY_API_KEY 
});

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const supabase = createClient(
  requireEnv("SUPABASE_URL"),
  requireEnv("SUPABASE_ANON_KEY")
)

