/*
 * Knotwire — GNU AGPL-3.0-only. See LICENSE in the repository root.
 * Independent implementation. No code from Kommo/amoCRM was used.
 *
 * WhatsApp provider boundary. Two implementations ship:
 *   - FakeWhatsAppClient: in-memory, deterministic, used by tests and dev.
 *   - HTTP client shape reserved for the real Cloud API wiring (post-creds).
 * Real Meta credentials are NOT required to build or test the inbox stack.
 */

export type DeliveryStatus = "sent" | "delivered" | "read" | "failed";
export type MessageType = "text" | "template" | "image" | "document" | "location" | "interactive";

export interface SendTextInput {
  to: string;
  text: string;
  type?: MessageType;
  templateName?: string;
  language?: string;
}

export interface SendResult {
  providerMessageId: string;
  status: DeliveryStatus;
}

export interface InboundMessage {
  providerMessageId: string;
  from: string;
  displayName?: string | undefined;
  text?: string;
  type?: MessageType;
  timestampSeconds?: number;
}

export interface WhatsAppClient {
  readonly kind: "fake" | "cloud";
  sendText(input: SendTextInput): Promise<SendResult>;
  templateIdFor(name: string, language: string): Promise<string>;
}

/** Meta's customer-service window: 24h from the last customer message. */
export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

export function isWithinServiceWindow(lastInboundAt: Date | null, now = new Date()): boolean {
  if (!lastInboundAt) return false;
  return now.getTime() - lastInboundAt.getTime() < SERVICE_WINDOW_MS;
}

/** In-memory fake: records every send; injectable inbound for tests. */
export class FakeWhatsAppClient implements WhatsAppClient {
  readonly kind = "fake" as const;
  readonly sent: Array<SendTextInput & { providerMessageId: string }> = [];
  failNext = false;
  private counter = 0;

  async sendText(input: SendTextInput): Promise<SendResult> {
    this.counter += 1;
    const providerMessageId = `wamid.fake_${this.counter}`;
    if (this.failNext) {
      this.failNext = false;
      return { providerMessageId, status: "failed" };
    }
    this.sent.push({ ...input, providerMessageId });
    return { providerMessageId, status: "sent" };
  }

  async templateIdFor(name: string, language: string): Promise<string> {
    return `fake:${name}:${language}`;
  }
}
