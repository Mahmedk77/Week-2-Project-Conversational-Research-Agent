"use client";

import { useEffect, useRef } from "react";
import type { KeyboardEvent } from "react";
import { ChevronUp } from "lucide-react";

const MAX_TEXTAREA_HEIGHT = 200;

export function ChatInput({
  value,
  onChange,
  onSend,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  disabled: boolean;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
  }, [value]);

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
          <textarea
            ref={textareaRef}
            rows={1}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask anything"
            autoComplete="off"
            autoCorrect="off"
            spellCheck="false"
            className="no-scrollbar flex-1 resize-none appearance-none overflow-y-auto bg-transparent py-1.5 text-[15px] leading-relaxed text-text-primary placeholder-text-primary/40 outline-none"
            style={{ minHeight: "1.75rem", maxHeight: `${MAX_TEXTAREA_HEIGHT}px` }}
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
