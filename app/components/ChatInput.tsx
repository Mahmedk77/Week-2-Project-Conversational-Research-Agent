"use client";

import { useRef } from "react";
import type { KeyboardEvent } from "react";
import { ChevronUp, Plus, Send, Trash2 } from "lucide-react";

export function ChatInput({
  value,
  onChange,
  onSend,
  onClearMemory,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onClearMemory: () => void;
  disabled: boolean;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (value.trim() && !disabled) onSend();
    }
  };

  return (
    <div className="sticky bottom-0 w-full bg-gradient-to-t from-bg-page via-bg-page to-transparent pb-[max(env(safe-area-inset-bottom),0px)] pt-4">
      <div className="mx-auto w-full max-w-[720px] px-4">
        <div className="flex items-end gap-2 rounded-3xl border border-border bg-surface-1 px-3 py-2 shadow-none transition-shadow focus-within:ring-2 focus-within:ring-border">
          <button
            type="button"
            onClick={onClearMemory}
            aria-label="Clear memory"
            title="Clear memory"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-text-primary/40 transition-colors hover:bg-border/60 hover:text-text-primary/70 active:text-text-primary"
          >
            <Trash2 className="h-4.5 w-4.5" strokeWidth={1.75} />
          </button>

          <textarea
            ref={textareaRef}
            rows={1}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask anything"
            className="max-h-32 flex-1 resize-none bg-transparent py-1.5 text-[15px] leading-relaxed text-text-primary placeholder-text-primary/40 outline-none"
            style={{ minHeight: "1.75rem" }}
          />

          <button
            type="button"
            onClick={onSend}
            disabled={disabled || !value.trim()}
            aria-label="Send message"
            className="flex h-9 w-9 shrink-0 items-center justify-center hover:bg-black/80 rounded-full bg-text-primary text-bg-page transition-opacity disabled:opacity-30"
          >
            <ChevronUp className="h-5 w-5" strokeWidth={1.75} />
          </button>
        </div>

        <p className="mt-2 pb-3 text-center text-[12px] text-text-primary/40">
          Responses may be inaccurate — verify important info
        </p>
      </div>
    </div>
  );
}
