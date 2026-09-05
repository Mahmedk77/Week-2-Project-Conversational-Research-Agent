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

  // Positioning/stickiness is owned by the page so the rate-limit notice can
  // share one sticky container with the composer.
  return (
    <div className="mx-auto w-full max-w-[720px] px-4">
      <div className="flex items-end gap-2 rounded-3xl border border-border bg-surface-card px-3 py-2 shadow-none transition-shadow focus-within:ring-2 focus-within:ring-border">
        <textarea
          ref={textareaRef}
          rows={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask a question…"
          autoComplete="off"
          autoCorrect="off"
          spellCheck="false"
          // 16px on mobile is deliberate: iOS Safari zooms the whole page when
          // focusing an input under 16px. Desktop keeps the tighter 15px.
          className="no-scrollbar placeholder:text-text-muted flex-1 resize-none appearance-none overflow-y-auto bg-transparent py-1.5 text-[16px] leading-relaxed text-text-primary outline-none sm:text-[15px]"
          style={{ minHeight: "1.75rem", maxHeight: `${MAX_TEXTAREA_HEIGHT}px` }}
        />

        <button
          type="button"
          onClick={onSend}
          disabled={disabled || !value.trim()}
          aria-label="Send message"
          // 44px hit area on touch screens (the accessible minimum), trimmed
          // to 36px on pointer devices where it would look oversized.
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-text-primary text-bg-page transition-opacity hover:opacity-90 disabled:bg-surface-1 disabled:text-text-muted sm:h-9 sm:w-9"
        >
          <ChevronUp className="h-5 w-5" strokeWidth={1.75} />
        </button>
      </div>

      <p className="mt-2 pb-3 text-center text-[12px] text-text-muted">
        Responses may be inaccurate — verify important info
      </p>
    </div>
  );
}
