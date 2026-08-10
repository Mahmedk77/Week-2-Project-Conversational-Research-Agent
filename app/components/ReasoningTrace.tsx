"use client";

import { useState } from "react";
import { ChevronDown, Wrench, FileText } from "lucide-react";
import type { ReasoningStep } from "./types";

function summarizeObservation(content: string): string {
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      return parsed
        .map((item) => {
          if (item && typeof item === "object") {
            const label = item.topic ?? item.title ?? null;
            const detail = item.content ?? item.snippet ?? "";
            return label ? `${label} — ${String(detail).slice(0, 80)}` : String(detail).slice(0, 100);
          }
          return String(item);
        })
        .join("; ");
    }
    return String(content).slice(0, 160);
  } catch {
    return content.length > 160 ? `${content.slice(0, 160)}…` : content;
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
                    {summarizeObservation(step.content)}
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
