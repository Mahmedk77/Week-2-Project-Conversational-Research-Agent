"use client";

import { useEffect, useState } from "react";
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
 * The status route.ts sends on its first attempt. Matched by value so the
 * generic ladder below can own the early wait, while a genuinely informative
 * server status (the model-fallback notice) takes over the moment it arrives.
 */
const DEFAULT_SERVER_STATUS = "Thinking…";

/**
 * The wait, in stages. Dots come first on their own; at each threshold they are
 * REPLACED by a short label — never both at once.
 *
 * The wording is deliberately generic. Naming an activity ("Searching…",
 * "Gathering…") would be inventing it: nothing about what the agent is actually
 * doing reaches the client mid-turn — the reasoning trace only arrives once the
 * answer is finished. These escalate with elapsed time, which is true.
 */
const WAIT_STAGES = [
  { after: 1200, label: "Thinking…" },
  { after: 6000, label: "Working on it…" },
  { after: 14000, label: "Still working…" },
] as const;

function ThinkingIndicator({ status }: { status?: string }) {
  // -1 while only the dots show.
  const [stage, setStage] = useState(-1);

  useEffect(() => {
    const timers = WAIT_STAGES.map((s, i) => setTimeout(() => setStage(i), s.after));
    return () => timers.forEach(clearTimeout);
  }, []);

  // A server status that isn't the generic opener is real information about a
  // real event (a model fell over and a backup is being tried), so it outranks
  // anything on the timer.
  const serverStatus = status && status !== DEFAULT_SERVER_STATUS ? status : undefined;
  const label = serverStatus ?? (stage >= 0 ? WAIT_STAGES[stage].label : undefined);

  return (
    <span className="flex min-h-6 items-center" role="status" aria-live="polite">
      {label ? (
        <span
          // `key` restarts the entrance animation on every change of wording.
          key={label}
          className="status-fade-in status-shimmer text-[13.5px] font-normal tracking-[0.01em]"
        >
          {label}
        </span>
      ) : (
        <TypingDots />
      )}
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
        <div className="max-w-[86%] rounded-2xl rounded-br-md border border-accent-soft-border bg-accent-soft px-4 py-3 sm:max-w-[75%]">
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
                  className="flex h-9 w-9 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary active:text-text-primary"
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
                    className="flex h-9 w-9 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary active:text-text-primary"
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
