"use client";

import { useState } from "react";
import { Copy, Check } from "lucide-react";
import { MarkdownContent } from "./MarkdownContent";
import { ReasoningTrace } from "./ReasoningTrace";
import type { ChatMessage } from "./types";

function TypingDots() {
  return (
    <span className="inline-flex items-center gap-1 py-1">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-text-primary/40 [animation-delay:0ms]" />
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-text-primary/40 [animation-delay:150ms]" />
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-text-primary/40 [animation-delay:300ms]" />
    </span>
  );
}

export function ChatMessageItem({ message }: { message: ChatMessage }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  if (message.role === "user") {
    return (
      <div className="flex justify-end px-4 py-2">
        <div className="max-w-[85%] rounded-3xl bg-surface-1 px-4 py-2.5 text-[15px] leading-relaxed text-text-primary sm:max-w-[75%]">
          <span className="whitespace-pre-wrap break-words">{message.content}</span>
        </div>
      </div>
    );
  }

  const showTyping = message.streaming && message.content.length === 0;

  return (
    <div className="px-4 py-2">
      <div className="max-w-full text-[15px] leading-relaxed text-text-primary">
        {showTyping ? (
          <TypingDots />
        ) : message.streaming ? (
          <span className="whitespace-pre-wrap break-words">{message.content}</span>
        ) : (
          <MarkdownContent content={message.content} />
        )}
      </div>

      {!message.streaming && message.content.length > 0 && (
        <div className="-mx-2.5 mt-1.5 flex items-center gap-1">
          <button
            type="button"
            onClick={handleCopy}
            aria-label="Copy response"
            className="flex min-h-11 min-w-11 items-center justify-center rounded-md text-text-primary/40 transition-colors hover:bg-surface-1 hover:text-text-primary/70 active:text-text-primary"
          >
            {copied ? (
              <Check className="h-4 w-4" strokeWidth={1.75} />
            ) : (
              <Copy className="h-4 w-4" strokeWidth={1.75} />
            )}
          </button>
        </div>
      )}

      {!message.streaming && message.reasoning && message.reasoning.length > 0 && (
        <ReasoningTrace steps={message.reasoning} />
      )}
    </div>
  );
}
