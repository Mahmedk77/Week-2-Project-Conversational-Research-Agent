"use client";

import { useEffect, useRef, useState } from "react";
import { ChatInput } from "./components/ChatInput";
import { ChatMessageItem } from "./components/ChatMessageItem";
import { EmptyState } from "./components/EmptyState";
import type { ChatMessage, ReasoningStep } from "./components/types";

const DELIMITER = "\n__REASONING_TRACE__\n";

function createId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export default function Home() {
  const [sessionId] = useState(() => createId());
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [clearing, setClearing] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  const sendMessage = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || isStreaming) return;

    const userMessage: ChatMessage = { id: createId(), role: "user", content: trimmed };
    const assistantId = createId();
    const assistantMessage: ChatMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
      streaming: true,
    };

    setMessages((prev) => [...prev, userMessage, assistantMessage]);
    setInput("");
    setIsStreaming(true);

    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: trimmed, sessionId }),
      });

      if (!res.body) throw new Error("No response body");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let visibleAnswer = "";
      let traceJson = "";
      let delimiterFound = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        if (!delimiterFound) {
          const idx = buffer.indexOf(DELIMITER);
          if (idx !== -1) {
            delimiterFound = true;
            visibleAnswer += buffer.slice(0, idx);
            traceJson += buffer.slice(idx + DELIMITER.length);
            buffer = "";

            setMessages((prev) =>
              prev.map((m) => (m.id === assistantId ? { ...m, content: visibleAnswer } : m))
            );
          } else {
            const safeLength = Math.max(0, buffer.length - DELIMITER.length);
            if (safeLength > 0) {
              visibleAnswer += buffer.slice(0, safeLength);
              buffer = buffer.slice(safeLength);

              setMessages((prev) =>
                prev.map((m) => (m.id === assistantId ? { ...m, content: visibleAnswer } : m))
              );
            }
          }
        } else {
          traceJson += buffer;
          buffer = "";
        }
      }

      if (!delimiterFound) {
        visibleAnswer += buffer;
      }

      let reasoning: ReasoningStep[] = [];
      try {
        if (traceJson.trim()) reasoning = JSON.parse(traceJson);
      } catch {
        reasoning = [];
      }

      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId ? { ...m, content: visibleAnswer, streaming: false, reasoning } : m
        )
      );
    } catch (err) {
      console.error("Chat stream error:", err);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? { ...m, content: "Something went wrong. Please try again.", streaming: false }
            : m
        )
      );
    } finally {
      setIsStreaming(false);
    }
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
              <ChatMessageItem key={message.id} message={message} />
            ))}
            <div ref={scrollRef} />
          </div>
        ) : (
          <EmptyState onSelect={sendMessage} />
        )}
      </div>

      <div className="sticky bottom-0 bg-bg-page">
        <ChatInput
          value={input}
          onChange={setInput}
          onSend={() => sendMessage(input)}
          disabled={isStreaming}
        />
      </div>
    </div>
  );
}
