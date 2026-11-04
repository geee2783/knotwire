/*
 * Knotwire — GNU AGPL-3.0-only. See LICENSE in the repository root.
 * Independent implementation. No code from Kommo/amoCRM was used.
 */

export type ActorKind = "user" | "bot" | "agent" | "system";

export type DomainEventType =
  | "lead.created"
  | "lead.updated"
  | "lead.stage_changed"
  | "lead.lost"
  | "contact.created"
  | "company.created"
  | "task.created"
  | "task.completed"
  | "message.received"
  | "message.sent"
  | "bot.triggered"
  | "bot.completed"
  | "bot.handed_off"
  | "appointment.booked";

export interface DomainEvent {
  id: string;
  ts: string;
  tenantId: string;
  actorKind: ActorKind;
  actorId: string;
  type: DomainEventType;
  entity: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
}

export function buildEvent(input: {
  tenantId: string;
  actorKind: ActorKind;
  actorId: string;
  type: DomainEventType;
  entity: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  id?: string;
  ts?: string;
}): DomainEvent {
  const id = input.id ?? globalThis.crypto.randomUUID();
  const ts = input.ts ?? new Date().toISOString();
  const event: DomainEvent = {
    id,
    ts,
    tenantId: input.tenantId,
    actorKind: input.actorKind,
    actorId: input.actorId,
    type: input.type,
    entity: input.entity,
  };
  if (input.entityId !== undefined) event.entityId = input.entityId;
  if (input.before !== undefined) event.before = input.before;
  if (input.after !== undefined) event.after = input.after;
  return event;
}
