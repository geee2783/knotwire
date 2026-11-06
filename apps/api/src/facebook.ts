/*
 * Knotwire — GNU AGPL-3.0-only. See LICENSE in the repository root.
 * Independent implementation. No code from Kommo/amoCRM was used.
 *
 * Facebook Messenger provider boundary (fake-first; real Graph API wiring
 * pending Meta decisions/credentials) + m.me attribution parsing.
 *
 * Attribution model (v1, per plan): Marketplace and campaign traffic reaches
 * us via m.me deep links carrying `ref=<code>`. The ref is stored on the
 * conversation and, when a lead is created from that conversation, copied to
 * the lead's source_ref so revenue can be attributed per source.
 */

export type MessengerMessageType = "text" | "attachment" | "quick_reply" | "postback";

export interface MessengerSendInput {
  recipientId: string;
  text: string;
  type?: MessengerMessageType;
}

export interface MessengerSendResult {
  providerMessageId: string;
  status: "sent" | "delivered" | "read" | "failed";
}

export interface MessengerClaim {
  ref?: string | undefined;
  sourceKind?: string | undefined;
  sourceUrl?: string | undefined;
}

export interface MessengerClient {
  readonly kind: "fake" | "graph";
  sendText(input: MessengerSendInput): Promise<MessengerSendResult>;
}

/** Parse an m.me deep-link referrer (`ref` query value). Returns the ref and its kind. */
export function parseMeRef(ref: string | null | undefined): { ref: string; kind: string } {
  if (!ref || typeof ref !== "string") return { ref: "", kind: "unknown" };
  const trimmed = ref.trim().slice(0, 200);
  if (trimmed.startsWith("mk_")) return { ref: trimmed, kind: "marketplace" };
  if (trimmed.startsWith("ad_")) return { ref: trimmed, kind: "facebook-ad" };
  if (trimmed.startsWith("post_")) return { ref: trimmed, kind: "page-post" };
  return { ref: trimmed, kind: "referral" };
}

/** Meta's 24h standard-message policy window for Messenger. */
export const MESSENGER_WINDOW_MS = 24 * 60 * 60 * 1000;

export function isWithinMessengerWindow(lastInboundAt: Date | null, now = new Date()): boolean {
  if (!lastInboundAt) return false;
  return now.getTime() - lastInboundAt.getTime() < MESSENGER_WINDOW_MS;
}

/** In-memory fake: records every send. */
export class FakeMessengerClient implements MessengerClient {
  readonly kind = "fake" as const;
  readonly sent: Array<MessengerSendInput & { providerMessageId: string }> = [];
  failNext = false;
  private counter = 0;

  async sendText(input: MessengerSendInput): Promise<MessengerSendResult> {
    this.counter += 1;
    const providerMessageId = `mid.fake_${this.counter}`;
    if (this.failNext) {
      this.failNext = false;
      return { providerMessageId, status: "failed" };
    }
    this.sent.push({ ...input, providerMessageId });
    return { providerMessageId, status: "sent" };
  }
}
