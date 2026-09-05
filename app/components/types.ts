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
  /**
   * Epoch ms, set when the message is created. Display-only. Safe against
   * hydration mismatch because the transcript always starts empty — every
   * message is created client-side, after mount.
   */
  createdAt?: number;
};
