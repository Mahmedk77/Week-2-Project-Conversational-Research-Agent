"use client";

import { useEffect, useRef, useState } from "react";
import { ChatInput } from "./components/ChatInput";
import { ChatMessageItem } from "./components/ChatMessageItem";
import { EmptyState } from "./components/EmptyState";
import type { ChatMessage, ReasoningStep } from "./components/types";

const DELIMITER = "\n__REASONING_TRACE__\n";

/**
 * The server wraps out-of-band frames in RS (0x1E) control characters. Two
 * kinds share the channel: a payload starting with `{` is JSON metadata (the
 * token budget), anything else is a progress note to display. Neither is part
 * of the answer, so both are pulled out before the text is rendered.
 *
 * A trailing unterminated frame is held back in `pending` so a frame split
 * across two chunks is never rendered as literal text.
 */
const STATUS_SENTINEL = "\x1e";

export type Budget = {
  usedLastMinute: number;
  limit: number;
  blockedForMs: number;
};

function extractFrames(buffer: string): {
  text: string;
  status?: string;
  budget?: Budget;
  pending: string;
} {
  if (!buffer.includes(STATUS_SENTINEL)) return { text: buffer, pending: "" };

  let text = "";
  let status: string | undefined;
  let budget: Budget | undefined;
  let rest = buffer;

  for (;;) {
    const open = rest.indexOf(STATUS_SENTINEL);
    if (open === -1) {
      text += rest;
      return { text, status, budget, pending: "" };
    }
    text += rest.slice(0, open);
    const close = rest.indexOf(STATUS_SENTINEL, open + 1);
    if (close === -1) {
      // Frame is still arriving — keep it buffered, don't render it.
      return { text, status, budget, pending: rest.slice(open) };
    }
    const payload = rest.slice(open + 1, close);
    if (payload.startsWith("{")) {
      try {
        budget = JSON.parse(payload) as Budget;
      } catch {
        // Malformed metadata is not worth failing the message over.
      }
    } else {
      status = payload;
    }
    rest = rest.slice(close + 1);
  }
}

const ERROR_MESSAGES = {
  badRequest: "That request couldn't be processed. Please rephrase and try again.",
  serverError: "The server ran into a problem. Please try again in a moment.",
  network: "Couldn't reach the server. Check your connection and try again.",
  interrupted: "The response was interrupted. Please try again.",
  unknown: "Something went wrong processing that request. Please try again.",
} as const;

class ChatRequestError extends Error {
  category: keyof typeof ERROR_MESSAGES;

  constructor(category: keyof typeof ERROR_MESSAGES, message: string) {
    super(message);
    this.category = category;
  }
}

function categorizeError(
  err: unknown,
  hadPartialContent: boolean,
  streamStarted: boolean
): keyof typeof ERROR_MESSAGES {
  if (err instanceof ChatRequestError) return err.category;
  if (hadPartialContent) return "interrupted";
  if (streamStarted) return "serverError";
  if (err instanceof TypeError) return "network";
  return "unknown";
}

function createId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export default function Home() {
  const [sessionId] = useState(() => createId());
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [clearing, setClearing] = useState(false);
  // Epoch ms until which sending is blocked because every model is rate-limited.
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  // Drive the countdown. State is only written from the interval callback —
  // never synchronously in the effect body — so this doesn't cascade renders.
  useEffect(() => {
    if (cooldownUntil <= 0) return;
    const id = setInterval(() => {
      if (Date.now() >= cooldownUntil) setCooldownUntil(0);
      else setNowTick(Date.now());
    }, 500);
    return () => clearInterval(id);
  }, [cooldownUntil]);

  const onBudget = (budget: Budget) => {
    if (budget.blockedForMs > 0) {
      setNowTick(Date.now());
      setCooldownUntil(Date.now() + budget.blockedForMs);
    } else {
      setCooldownUntil(0);
    }
  };

  const secondsLeft = cooldownUntil > 0 ? Math.max(0, Math.ceil((cooldownUntil - nowTick) / 1000)) : 0;
  const coolingDown = cooldownUntil > 0 && secondsLeft > 0;

  const sendMessage = async (text: string, options?: { skipUserMessage?: boolean }) => {
    const trimmed = text.trim();
    if (!trimmed || isStreaming || Date.now() < cooldownUntil) return;

    const assistantId = createId();
    const assistantMessage: ChatMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
      streaming: true,
    };

    if (options?.skipUserMessage) {
      setMessages((prev) => [...prev, assistantMessage]);
    } else {
      const userMessage: ChatMessage = { id: createId(), role: "user", content: trimmed };
      setMessages((prev) => [...prev, userMessage, assistantMessage]);
    }
    setInput("");
    setIsStreaming(true);

    let visibleAnswer = "";
    let streamStarted = false;
    let latestStatus: string | undefined;

    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: trimmed, sessionId }),
      });

      if (!res.ok || !res.body) {
        if (res.status === 400) {
          throw new ChatRequestError("badRequest", `Request failed with status ${res.status}`);
        }
        if (res.status >= 500) {
          throw new ChatRequestError("serverError", `Request failed with status ${res.status}`);
        }
        throw new ChatRequestError("unknown", `Request failed with status ${res.status}`);
      }

      streamStarted = true;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let traceJson = "";
      let delimiterFound = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        if (!delimiterFound) {
          // Pull status frames out FIRST. They are self-delimiting, and a lone
          // frame is shorter than DELIMITER — so the hold-back below would keep
          // it buffered and it would never render while the user is waiting,
          // which is exactly when it is useful.
          if (buffer.includes(STATUS_SENTINEL)) {
            const scanned = extractFrames(buffer);
            buffer = scanned.text + scanned.pending;
            if (scanned.budget) onBudget(scanned.budget);
            if (scanned.status) {
              latestStatus = scanned.status;
              setMessages((prev) =>
                prev.map((m) => (m.id === assistantId ? { ...m, status: latestStatus } : m))
              );
            }
          }

          const idx = buffer.indexOf(DELIMITER);
          if (idx !== -1) {
            delimiterFound = true;
            visibleAnswer += buffer.slice(0, idx);
            traceJson += buffer.slice(idx + DELIMITER.length);
            buffer = "";

            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId ? { ...m, content: visibleAnswer, status: undefined } : m
              )
            );
          } else {
            const safeLength = Math.max(0, buffer.length - DELIMITER.length);
            if (safeLength > 0) {
              visibleAnswer += buffer.slice(0, safeLength);
              buffer = buffer.slice(safeLength);

              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId
                    ? { ...m, content: visibleAnswer, status: visibleAnswer ? undefined : latestStatus }
                    : m
                )
              );
            }
          }
        } else {
          traceJson += buffer;
          buffer = "";
        }
      }

      if (!delimiterFound) {
        const tail = extractFrames(buffer);
        visibleAnswer += tail.text;
        if (tail.budget) onBudget(tail.budget);
      }

      let reasoning: ReasoningStep[] = [];
      try {
        if (traceJson.trim()) reasoning = JSON.parse(traceJson);
      } catch {
        reasoning = [];
      }

      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? { ...m, content: visibleAnswer, streaming: false, reasoning, status: undefined }
            : m
        )
      );
    } catch (err) {
      console.error("Chat stream error:", err);
      const category = categorizeError(err, Boolean(visibleAnswer), streamStarted);
      const errorMessage = ERROR_MESSAGES[category];
      const fallbackContent = visibleAnswer ? `${visibleAnswer}\n\n${errorMessage}` : errorMessage;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? { ...m, content: fallbackContent, streaming: false, status: undefined }
            : m
        )
      );
    } finally {
      setIsStreaming(false);
    }
  };

  const retryMessage = (assistantMessageId: string) => {
    if (isStreaming) return;

    const index = messages.findIndex((m) => m.id === assistantMessageId);
    if (index <= 0) return;
    const precedingUserMessage = messages[index - 1];
    if (precedingUserMessage.role !== "user") return;

    setMessages((prev) => prev.filter((m) => m.id !== assistantMessageId));
    sendMessage(precedingUserMessage.content, { skipUserMessage: true });
  };

  const handleClearMemory = async () => {
    if (clearing) return;
    setClearing(true);
    try {
      await fetch("/api/memory", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      setMessages([]);
    } catch (err) {
      console.error("Clear memory error:", err);
    } finally {
      setClearing(false);
    }
  };

  const hasMessages = messages.length > 0;

  return (
    <div className="flex min-h-screen flex-1 flex-col bg-bg-page">
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-bg-page px-4 py-3">
        <span className="text-[14px] font-medium text-text-primary">
          Research agent
        </span>
        <button
          type="button"
          onClick={handleClearMemory}
          disabled={clearing}
          className="flex min-h-11 items-center gap-1.5 rounded-full px-3.5 text-[13px] text-text-primary/60 transition-colors hover:text-text-primary/90 disabled:opacity-40"
        >
          Clear memory
        </button>
      </header>

      <div className="mx-auto flex w-full max-w-[720px] flex-1 flex-col">
        {hasMessages ? (
          <div className="flex-1 pb-4 pt-2">
            {messages.map((message) => (
              <ChatMessageItem key={message.id} message={message} onRetry={retryMessage} />
            ))}
            <div ref={scrollRef} />
          </div>
        ) : (
          <EmptyState onSelect={sendMessage} />
        )}
      </div>

      <div className="sticky bottom-0 bg-bg-page">
        {coolingDown && (
          <div
            role="status"
            aria-live="polite"
            className="mx-auto mb-1 flex w-full max-w-[720px] items-center gap-2 px-4 text-[13px] text-text-primary/60"
          >
            <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-text-primary/40" />
            <span>
              Usage limit reached — you can send again in {secondsLeft}
              {secondsLeft === 1 ? " second" : " seconds"}.
            </span>
          </div>
        )}
        <ChatInput
          value={input}
          onChange={setInput}
          onSend={() => sendMessage(input)}
          disabled={isStreaming || coolingDown}
        />
      </div>
    </div>
  );
}
