import { ChatOpenAI } from "@langchain/openai";
import { createClient } from "@supabase/supabase-js";
import { tavily } from "@tavily/core";

export const groqModel = new ChatOpenAI({
  model: "openai/gpt-oss-20b",
  apiKey: process.env.GROQ_API_KEY,
  configuration: {
    baseURL: "https://api.groq.com/openai/v1",
  },
});

export const openRouterModel = new ChatOpenAI({
  model: "meta-llama/llama-3-8b-instruct",
  apiKey: process.env.OPENROUTER_API_KEY,
  configuration: {
    baseURL: "https://openrouter.ai/api/v1",
  },
});

export const tavilyClient  = tavily({ 
  apiKey: process.env.TAVILY_API_KEY 
});

export const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
)

