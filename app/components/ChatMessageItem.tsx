"use client";

import { useState } from "react";
import { BotMessageSquare, Check, Copy, RotateCw, User } from "lucide-react";
import { MarkdownContent } from "./MarkdownContent";
import { ReasoningTrace } from "./ReasoningTrace";
import type { ChatMessage } from "./types";

function TypingDots() {
  return (
    <span className="inline-flex items-center gap-1" aria-hidden="true">
      <span className="typing-dot h-1.5 w-1.5 rounded-full bg-text-muted [animation-delay:0ms]" />
      <span className="typing-dot h-1.5 w-1.5 rounded-full bg-text-muted [animation-delay:160ms]" />
      <span className="typing-dot h-1.5 w-1.5 rounded-full bg-text-muted [animation-delay:320ms]" />
    </span>
  );
}

/**
 * Dots and the current step on ONE row. Stacked, they read as two unrelated
 * fragments floating in a tall empty card.
 *
 * The label always renders: the server's first status frame can lag the bubble
 * by a moment, and bare dots say nothing about what is happening.
 */
function ThinkingIndicator({ status }: { status?: string }) {
  const label = status ?? "Thinking…";
  return (
    <span className="flex items-center gap-2.5" role="status" aria-live="polite">
      <TypingDots />
      <span
        // `key` restarts the entrance animation when the label changes
        // (e.g. "Thinking…" -> "Model busy: trying a backup…").
        key={label}
        className="status-fade-in status-shimmer text-[13.5px] font-normal tracking-[0.01em]"
      >
        {label}
      </span>
    </span>
  );
}

function formatTime(createdAt?: number): string | null {
  if (!createdAt) return null;
  return new Date(createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function Avatar({ children, working }: { children: React.ReactNode; working?: boolean }) {
  return (
    <span
      className={`relative mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border bg-surface-card text-text-secondary${
        working ? " avatar-working" : ""
      }`}
    >
      {children}
    </span>
  );
}

export function ChatMessageItem({
  message,
  onRetry,
}: {
  message: ChatMessage;
  onRetry?: (messageId: string) => void;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const time = formatTime(message.createdAt);

  if (message.role === "user") {
    return (
      <div className="flex justify-end gap-2.5 px-4 py-2.5">
        {/* The avatar is desktop-only: on a 360px screen the bubble needs
            every pixel more than the transcript needs a second face. */}
        <div className="max-w-[86%] rounded-2xl rounded-br-md bg-surface-1 px-4 py-3 sm:max-w-[75%]">
          <p className="whitespace-pre-wrap break-words text-[15px] leading-relaxed text-text-primary">
            {message.content}
          </p>
          {time && (
            <p className="mt-1 text-right text-[11.5px] leading-none text-text-muted">{time}</p>
          )}
        </div>
        <span className="hidden sm:block">
          <Avatar>
            <User className="h-4 w-4" strokeWidth={1.75} />
          </Avatar>
        </span>
      </div>
    );
  }

  const showTyping = message.streaming && message.content.length === 0;
  const hasContent = message.content.length > 0;
  const hasReasoning = Boolean(message.reasoning && message.reasoning.length > 0);
  const showActions = !message.streaming && hasContent;

  return (
    <div className="flex gap-2.5 px-4 py-2.5">
      <Avatar working={message.streaming}>
        <BotMessageSquare className="h-4 w-4" strokeWidth={1.75} />
      </Avatar>

      {/* min-w-0 lets the card shrink inside the flex row; without it long
          unbroken tokens (URLs) push the whole transcript sideways. */}
      <div className="min-w-0 flex-1">
        <div className="rounded-2xl rounded-tl-md border border-border bg-surface-card px-4 py-3.5">
          <div className="max-w-full text-[15px] leading-relaxed text-text-primary">
            {showTyping ? (
              <ThinkingIndicator status={message.status} />
            ) : message.streaming ? (
              <span className="whitespace-pre-wrap break-words">{message.content}</span>
            ) : (
              <MarkdownContent content={message.content} />
            )}
          </div>

          {showActions && (
            <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-2 border-t border-border/70 pt-2.5">
              {hasReasoning && <ReasoningTrace steps={message.reasoning!} />}

              <div className="ml-auto flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={handleCopy}
                  aria-label="Copy response"
                  className="flex h-9 w-9 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-surface-1 hover:text-text-primary active:text-text-primary"
                >
                  {copied ? (
                    <Check className="h-4 w-4" strokeWidth={1.75} />
                  ) : (
                    <Copy className="h-4 w-4" strokeWidth={1.75} />
                  )}
                </button>

                {onRetry && (
                  <button
                    type="button"
                    onClick={() => onRetry(message.id)}
                    aria-label="Retry"
                    className="flex h-9 w-9 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-surface-1 hover:text-text-primary active:text-text-primary"
                  >
                    <RotateCw className="h-4 w-4" strokeWidth={1.75} />
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
