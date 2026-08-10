"use client";

import { useState } from "react";
import { ChevronDown, Wrench, FileText } from "lucide-react";
import type { ReasoningStep } from "./types";

const MAX_SUMMARY_LENGTH = 180;

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

function cleanAndTruncate(text: string, maxLength: number): string {
  return truncateAtWordBoundary(stripMarkdownArtifacts(text), maxLength);
}

function summarizeObservation(content: string): string {
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      const joined = parsed
        .map((item) => {
          if (item && typeof item === "object") {
            const label = item.topic ?? item.title ?? null;
            const detail = item.content ?? item.snippet ?? "";
            const cleanDetail = stripMarkdownArtifacts(String(detail));
            return label ? `${stripMarkdownArtifacts(String(label))} — ${cleanDetail}` : cleanDetail;
          }
          return stripMarkdownArtifacts(String(item));
        })
        .join("; ");
      return truncateAtWordBoundary(joined, MAX_SUMMARY_LENGTH);
    }
    return cleanAndTruncate(String(content), MAX_SUMMARY_LENGTH);
  } catch {
    return cleanAndTruncate(content, MAX_SUMMARY_LENGTH);
  }
}

function formatArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args);
  if (entries.length === 0) return "";
  return entries.map(([k, v]) => `${k}: ${String(v)}`).join(", ");
}

export function ReasoningTrace({ steps }: { steps: ReasoningStep[] }) {
  const [expanded, setExpanded] = useState(false);

  if (!steps || steps.length === 0) return null;

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1 rounded-md py-1.5 px-1 text-[13px] text-text-primary/55 transition-colors hover:text-text-primary active:text-text-primary"
      >
        <ChevronDown
          className={`h-3.5 w-3.5 transition-transform ${expanded ? "rotate-180" : ""}`}
          strokeWidth={1.75}
        />
        {expanded ? "Hide reasoning" : "Show reasoning"}
      </button>

      {expanded && (
        <div className="mt-1.5 space-y-2 rounded-xl border border-border bg-surface-1 p-3 text-[13px] leading-relaxed text-text-primary/70">
          {steps.map((step, i) => (
            <div key={i} className="flex gap-2">
              {step.type === "action" ? (
                <>
                  <Wrench
                    className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-primary/40"
                    strokeWidth={1.75}
                  />
                  <div>
                    {step.tool_calls.map((call, j) => (
                      <div key={j}>
                        <span className="font-medium text-text-primary/85">
                          Called {call.name}
                        </span>
                        {formatArgs(call.args) && <span> — {formatArgs(call.args)}</span>}
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <>
                  <FileText
                    className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-primary/40"
                    strokeWidth={1.75}
                  />
                  <div>
                    <span className="font-medium text-text-primary/85">Result:</span>{" "}
                    <span className="font-mono text-[12px] text-text-primary/60">
                      {summarizeObservation(step.content)}
                    </span>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
