"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Copy, FileText, ListTree, Wrench, X } from "lucide-react";
import type { ReasoningStep } from "./types";

/** Long enough to be useful in a dialog; the panel scrolls if it overflows. */
const MAX_OBSERVATION_LENGTH = 700;

function stripMarkdownArtifacts(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateAtWordBoundary(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const slice = text.slice(0, maxLength);
  const lastSpace = slice.lastIndexOf(" ");
  const clean = lastSpace > 0 ? slice.slice(0, lastSpace) : slice;
  return `${clean.trim()}...`;
}

/**
 * Tool results arrive as raw JSON (search payloads, KB rows) or plain strings.
 * Flatten either into one readable line of prose — the dialog is for
 * understanding what the agent saw, not for reading machine output.
 */
function summarizeObservation(content: string, maxLength = MAX_OBSERVATION_LENGTH): string {
  const flatten = (value: unknown): string => {
    if (Array.isArray(value)) return value.map(flatten).filter(Boolean).join("; ");
    if (value && typeof value === "object") {
      const row = value as Record<string, unknown>;
      // `answer` is Tavily's own synthesised reply and is the single most
      // useful field when present, so lead with it.
      const parts = [row.answer, row.topic ?? row.title, row.content ?? row.snippet]
        .filter((v) => typeof v === "string" && v.trim())
        .map((v) => stripMarkdownArtifacts(String(v)));
      if (parts.length > 0) return parts.join(" — ");
      if (Array.isArray(row.results)) return flatten(row.results);
      return "";
    }
    if (value === null || value === undefined) return "";
    return stripMarkdownArtifacts(String(value));
  };

  try {
    const parsed = JSON.parse(content);
    const flat = flatten(parsed);
    return truncateAtWordBoundary(flat || stripMarkdownArtifacts(content), maxLength);
  } catch {
    return truncateAtWordBoundary(stripMarkdownArtifacts(content), maxLength);
  }
}

/**
 * `web_search` is declared with a raw JSON Schema so unknown keys don't crash
 * it (see route.ts), which means LangChain doesn't parse its args back out —
 * they routinely arrive as `{}`. Callers must handle the empty string rather
 * than rendering an empty block.
 */
function formatArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== "")
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join(", ");
}

/** Distinct tool names, in the order the agent first reached for them. */
function toolsUsed(steps: ReasoningStep[]): string[] {
  const names: string[] = [];
  for (const step of steps) {
    const stepNames =
      step.type === "action" ? step.tool_calls.map((c) => c.name) : [step.tool];
    for (const name of stepNames) {
      if (name && !names.includes(name)) names.push(name);
    }
  }
  return names;
}

function traceToPlainText(steps: ReasoningStep[]): string {
  return steps
    .map((step, i) => {
      const n = i + 1;
      if (step.type === "action") {
        return step.tool_calls
          .map((call) => {
            const args = formatArgs(call.args);
            return `${n}. Called ${call.name}${args ? ` — ${args}` : ""}`;
          })
          .join("\n");
      }
      return `${n}. Result from ${step.tool}\n${summarizeObservation(step.content, Number.MAX_SAFE_INTEGER)}`;
    })
    .join("\n\n");
}

function StepTile({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border bg-bg-page text-text-secondary">
      {children}
    </span>
  );
}

function StepCard({ step, index }: { step: ReasoningStep; index: number }) {
  const isAction = step.type === "action";

  return (
    <li className="rounded-2xl border border-border bg-surface-card p-3 sm:p-3.5">
      <div className="flex min-w-0 gap-3">
        <StepTile>
          {isAction ? (
            <Wrench className="h-4 w-4" strokeWidth={1.75} />
          ) : (
            <FileText className="h-4 w-4" strokeWidth={1.75} />
          )}
        </StepTile>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[13px] font-medium text-text-muted">[{index + 1}]</span>
            <span className="min-w-0 break-words text-[14px] font-medium text-text-primary">
              {isAction
                ? step.tool_calls.map((c) => c.name).join(", ") || "tool"
                : step.tool}
            </span>
            <span className="rounded-full border border-border bg-bg-page px-2 py-0.5 text-[11.5px] text-text-secondary">
              {isAction ? "tool call" : "result"}
            </span>
          </div>

          {isAction ? (
            <>
              {step.tool_calls.map((call, j) => {
                const args = formatArgs(call.args);
                if (!args) return null;
                return (
                  <p
                    key={j}
                    className="mt-2 break-words rounded-xl bg-bg-page px-3 py-2 font-mono text-[12px] leading-relaxed text-text-secondary"
                  >
                    {args}
                  </p>
                );
              })}
            </>
          ) : (
            <p className="mt-2 break-words rounded-xl bg-bg-page px-3 py-2 text-[13.5px] italic leading-relaxed text-text-secondary">
              <span aria-hidden="true" className="text-text-muted">
                &ldquo;
              </span>
              {summarizeObservation(step.content)}
              <span aria-hidden="true" className="text-text-muted">
                &rdquo;
              </span>
            </p>
          )}
        </div>
      </div>
    </li>
  );
}

function ReasoningDialog({
  steps,
  onClose,
}: {
  steps: ReasoningStep[];
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [copied, setCopied] = useState(false);

  const handleCopyAll = async () => {
    await navigator.clipboard.writeText(traceToPlainText(steps));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    closeButtonRef.current?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      // Keep Tab inside the dialog — without this, tabbing walks off into the
      // page behind the overlay, which a keyboard user can't see.
      if (e.key !== "Tab" || !panelRef.current) return;
      const focusable = panelRef.current.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    // The page itself scrolls (the transcript is document-level), so the body
    // has to be pinned or the sheet drags the conversation around under it.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus?.();
    };
  }, [onClose]);

  const tools = toolsUsed(steps);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="reasoning-dialog-title"
    >
      <button
        type="button"
        aria-label="Close reasoning"
        onClick={onClose}
        className="overlay-fade absolute inset-0 cursor-default bg-[var(--overlay)]"
      />

      <div
        ref={panelRef}
        className="modal-panel relative flex max-h-[86dvh] w-full flex-col overflow-hidden rounded-t-3xl border border-border bg-bg-page sm:max-h-[80vh] sm:max-w-2xl sm:rounded-3xl"
      >
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4 sm:px-6 sm:py-5">
          <div className="min-w-0">
            <h2
              id="reasoning-dialog-title"
              className="text-[20px] font-medium leading-tight text-text-primary sm:text-[22px]"
            >
              Reasoning
            </h2>
            <p className="mt-1 text-[13px] text-text-secondary">
              {steps.length} {steps.length === 1 ? "step" : "steps"} behind this answer
              {tools.length > 0 && ` · ${tools.join(", ")}`}
            </p>
          </div>

          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border bg-surface-card text-text-secondary transition-colors hover:bg-surface-1 hover:text-text-primary"
          >
            <X className="h-4 w-4" strokeWidth={1.75} />
          </button>
        </div>

        <ol className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-4 py-4 sm:px-6 sm:py-5">
          {steps.map((step, i) => (
            <StepCard key={i} step={step} index={i} />
          ))}
        </ol>

        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6 sm:py-4 sm:pb-4">
          <button
            type="button"
            onClick={handleCopyAll}
            className="flex min-h-11 items-center gap-2 rounded-full border border-border bg-surface-card px-4 text-[14px] text-text-secondary transition-colors hover:bg-surface-1 hover:text-text-primary sm:min-h-10"
          >
            {copied ? (
              <Check className="h-4 w-4" strokeWidth={1.75} />
            ) : (
              <Copy className="h-4 w-4" strokeWidth={1.75} />
            )}
            {copied ? "Copied" : "Copy all"}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="flex min-h-11 items-center rounded-full bg-text-primary px-5 text-[14px] text-bg-page transition-opacity hover:opacity-90 sm:min-h-10"
          >
            Done
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

export function ReasoningTrace({ steps }: { steps: ReasoningStep[] }) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  const close = useCallback(() => setOpen(false), []);

  if (!steps || steps.length === 0) return null;

  const tools = toolsUsed(steps);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex min-h-9 items-center gap-2 rounded-full border border-border bg-bg-page px-3 text-[13px] text-text-secondary transition-colors hover:bg-surface-1 hover:text-text-primary"
      >
        <ListTree className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
        View reasoning
        <span className="rounded-full bg-surface-1 px-1.5 text-[11.5px] text-text-secondary">
          {steps.length}
        </span>
      </button>

      {tools.length > 0 && (
        <span className="hidden text-[12.5px] text-text-muted sm:inline">
          Used {tools.join(", ")}
        </span>
      )}

      {open && mounted && <ReasoningDialog steps={steps} onClose={close} />}
    </>
  );
}
