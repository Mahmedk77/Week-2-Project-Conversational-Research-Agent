"use client";

import { Sparkles, BookOpen, Brain, Newspaper, BotMessageSquare } from "lucide-react";

const SUGGESTIONS = [
  { icon: BookOpen, text: "What is pgvector?" },
  { icon: Brain, text: "Explain LangChain memory types" },
  { icon: Newspaper, text: "Latest news on AI agents" },
];

export function EmptyState({ onSelect }: { onSelect: (text: string) => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-4 pb-24">
      <div className="mb-6 flex h-14 w-14 items-center justify-center rounded-full bg-text-primary text-bg-page">
        <BotMessageSquare className="h-8 w-8" strokeWidth={1.75} />
      </div>
      <h1 className="text-2xl font-medium text-text-primary">Hi, there</h1>
      <p className="mt-1.5 text-[15px] text-text-primary/60">
        Ask me anything about LangChain, Supabase, or n8n
      </p>

      <div className="mt-8 grid w-full max-w-lg grid-cols-1 gap-2.5 sm:grid-cols-3">
        {SUGGESTIONS.map(({ icon: Icon, text }) => (
          <button
            key={text}
            type="button"
            onClick={() => onSelect(text)}
            className="flex flex-col items-start gap-2.5 rounded-2xl border border-border bg-surface-1 p-3.5 text-left transition-colors hover:bg-border/30  active:bg-border/50"
          >
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-border/50 text-text-primary/70">
              <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
            </span>
            <span className="text-[13.5px] leading-snug text-text-primary/80">{text}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
