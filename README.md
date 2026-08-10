# Week 2: Conversational Research Agent

Streaming AI agent with tool calling and session memory, built on LangChain's `createAgent` (LangGraph-backed) and Groq.

## What it does
- Agent with 2 tools: Tavily web search, Supabase knowledge base lookup
- Session memory: Supabase-backed, auto-summarized across turns
- Streams the final answer token-by-token
- Collapsible "reasoning" panel showing each tool call and result per turn
- Clear memory button (deletes the session's row from Supabase)

## Stack
Next.js (App Router), TypeScript, LangChain, Groq, Supabase, Tavily, Tailwind

## Notable technical points
- Tested the agent uncapped before adding a `recursionLimit`, confirmed it loops indefinitely without one
- Single response stream carries both the live answer text and the full reasoning trace (delimited), avoiding a second LLM call that could return inconsistent output
- Memory persists across serverless requests via Supabase, not in-process state

## Known limitation
Knowledge base search uses plain substring matching (`ILIKE`), not semantic search, misses on paraphrased queries. Addressed in Week 3 with pgvector.
