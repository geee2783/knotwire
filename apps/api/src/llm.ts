/*
 * Knotwire — GNU AGPL-3.0-only. See LICENSE in the repository root.
 * Independent implementation. No code from Kommo/amoCRM was used.
 *
 * Model-agnostic LLM boundary. FakeLlmClient is deterministic and keyless
 * (used by tests and dev); the HTTP adapter shape is reserved for OpenAI-
 * compatible endpoints and wires in with a user-supplied key.
 *
 * Fake behavior (documented, deterministic):
 *   - KB keyword hit  -> answer from the matched source text
 *   - "price of X"    -> lookup_product tool call
 *   - asks for human  -> hand_off tool call
 *   - otherwise       -> short helpful reply
 */

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface LlmTurn {
  text: string;
  toolCalls: ToolCall[];
}

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  text: string;
}

export interface LlmRequest {
  model?: string | undefined;
  system: string;
  messages: LlmMessage[];
  tools: string[];
  knowledge: Array<{ title: string; content: string }>;
}

export interface LlmResult {
  turn: LlmTurn;
  usage: { promptTokens: number; completionTokens: number; costUsd: number };
}

export interface LlmClient {
  readonly kind: string;
  complete(request: LlmRequest): Promise<LlmResult>;
}

function tokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function kbHit(query: string, knowledge: Array<{ title: string; content: string }>): string | null {
  const q = query.toLowerCase();
  let best: string | null = null;
  let bestScore = 0;
  for (const doc of knowledge) {
    const words = doc.content.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
    let score = 0;
    for (const w of words) if (q.includes(w)) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = doc.content;
    }
  }
  return bestScore > 0 ? best : null;
}

export class FakeLlmClient implements LlmClient {
  readonly kind = "fake";

  async complete(request: LlmRequest): Promise<LlmResult> {
    const last = [...request.messages].reverse().find((m) => m.role === "user")?.text ?? "";
    const lower = last.toLowerCase();
    let turn: LlmTurn;

    if (/(human|person|agent|manager|operator|real)/.test(lower) && request.tools.includes("hand_off")) {
      turn = { text: "", toolCalls: [{ name: "hand_off", args: { reason: "customer_requested_human" } }] };
    } else if (request.tools.includes("lookup_product") && /price|cost|how much/.test(lower)) {
      turn = { text: "", toolCalls: [{ name: "lookup_product", args: { query: last } }] };
    } else {
      const hit = kbHit(last, request.knowledge);
      turn = { text: hit ?? "Thanks for your message! How can I help you today?", toolCalls: [] };
    }
    return {
      turn,
      usage: {
        promptTokens: tokens(request.messages.map((m) => m.text).join(" ")),
        completionTokens: tokens(turn.text),
        costUsd: 0,
      },
    };
  }
}
