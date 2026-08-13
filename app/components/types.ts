export type ChatRole = "user" | "assistant";

export type ReasoningStep =
  | { type: "action"; tool_calls: { name: string; args: Record<string, unknown> }[] }
  | { type: "observation"; tool: string; content: string };

export type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  reasoning?: ReasoningStep[];
  streaming?: boolean;
  /** Transient progress note shown while waiting (e.g. during model fallback). */
  status?: string;
};
