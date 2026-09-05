"use client";

import { BookOpen, Brain, Newspaper, BotMessageSquare } from "lucide-react";

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
      <h1 className="text-2xl font-medium text-text-primary">Hi, there!</h1>
      <p className="mt-1.5 text-balance text-center text-[15px] text-text-secondary">
        Ask me anything about LangChain, Supabase, or n8n
      </p>

      <div className="mt-8 grid w-full max-w-lg grid-cols-1 gap-2.5 sm:grid-cols-3">
        {SUGGESTIONS.map(({ icon: Icon, text }) => (
          <button
            key={text}
            type="button"
            onClick={() => onSelect(text)}
            // Row layout on phones (cards would otherwise be tall and empty),
            // stacked once there are three across.
            className="flex min-h-11 items-center gap-2.5 rounded-2xl border border-border bg-surface-card p-3.5 text-left transition-colors hover:bg-surface-1 active:bg-border/50 sm:flex-col sm:items-start"
          >
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-1 text-text-secondary">
              <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
            </span>
            <span className="min-w-0 text-[13.5px] leading-snug text-text-secondary">{text}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
