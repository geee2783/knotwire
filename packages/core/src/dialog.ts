/*
 * Knotwire — GNU AGPL-3.0-only. See LICENSE in the repository root.
 * Independent implementation. No code from Kommo/amoCRM was used.
 *
 * Dialog engine: a deterministic interpreter over an ORIGINAL typed step
 * schema (Knotwire "dialog v1"). No Salesbot JSON, handlers, or UI shapes are
 * copied — only the observable contract ("bots can ask, branch, validate, and
 * act on CRM entities from a chat") is reproduced.
 *
 * Step types (each step is an object with `t` + fields):
 *   say        { text }                                  send text, advance
 *   buttons    { text, options: string[] }               send prompt, wait for a matching reply (exact or contains, case-insensitive)
 *   ask        { text, var }                             send prompt, store reply in variables[var]
 *   set_lead_field  { key, value }                       lead.custom_fields[key] = rendered value
 *   set_tag    { value } | remove_tag { value }          tag arithmetic on the session lead
 *   move_stage { stageId } | move_stage { stageName }    move session lead to stage
 *   create_task{ title } | add_note { text }             write task/note on session lead
 *   assign     { userId }                                set lead responsible
 *   condition  { var, op: eq|ne|contains, value, then, else }  branch (indexes)
 *   validate   { var, kind: regex|email|phone, re?, on_fail, on_pass }  branch
 *   find_contact { var }                                 look up contact by phone/email in vars; set vars[found_id|found_name]
 *   goto       { step }                                  unconditional jump
 *   wait       {}                                        pause until next inbound reply
 *   stop       {}                                        finish session
 *
 * Variables support {{dot.path}} templating against { vars, message_text,
 * lead, contact, bot }.
 */

export type StepType =
  | "say"
  | "buttons"
  | "ask"
  | "set_lead_field"
  | "set_tag"
  | "remove_tag"
  | "move_stage"
  | "create_task"
  | "add_note"
  | "assign"
  | "condition"
  | "validate"
  | "find_contact"
  | "goto"
  | "wait"
  | "stop";

export interface DialogStep {
  t: StepType;
  text?: string | undefined;
  var?: string | undefined;
  key?: string | undefined;
  value?: string | undefined;
  options?: string[] | undefined;
  stageId?: string | undefined;
  stageName?: string | undefined;
  userId?: string | undefined;
  op?: "eq" | "ne" | "contains" | undefined;
  kind?: "regex" | "email" | "phone" | undefined;
  re?: string | undefined;
  then?: number | undefined;
  else?: number | undefined;
  on_pass?: number | undefined;
  on_fail?: number | undefined;
  step?: number | undefined;
  title?: string | undefined;
}

export interface DialogBot {
  id: string;
  name: string;
  status: "draft" | "published";
  version: number;
  steps: DialogStep[];
}

export interface SessionState {
  botId: string;
  currentStep: number;
  variables: Record<string, unknown>;
  state: "active" | "finished" | "failed";
  leadId?: string | undefined;
  lastReply?: string | undefined;
  waitingStep?: number | undefined;
}

export interface EngineContext {
  lead: { id: string; name: string; price?: unknown; custom_fields?: Record<string, unknown>; tags?: string[] } | null;
  contact: { name?: string | undefined; phone?: string | undefined; email?: string | undefined } | null;
  messageText?: string | undefined;
  botName: string;
}

export interface BotAction {
  kind:
    | "say"
    | "set_lead_field"
    | "add_tag"
    | "remove_tag"
    | "move_stage"
    | "create_task"
    | "add_note"
    | "assign"
    | "find_contact";
  [key: string]: unknown;
}

export interface EngineOutcome {
  session: SessionState;
  sent: string[];
  actions: BotAction[];
  finished: boolean;
  error?: string | undefined;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /\+?\d[\d\s\-()]{6,}\d/;

function lookup(path: string, ctx: EngineContext, vars: Record<string, unknown>): unknown {
  const parts = path.trim().split(".");
  let value: unknown;
  if (parts[0] === "vars") {
    value = vars;
  } else if (parts[0] === "lead") {
    value = ctx.lead ?? {};
  } else if (parts[0] === "contact") {
    value = ctx.contact ?? {};
  } else if (parts[0] === "message_text") {
    return ctx.messageText ?? "";
  } else if (parts[0] === "bot") {
    return { name: ctx.botName };
  } else {
    value = vars;
  }
  const rest = parts[0] === "vars" || parts[0] === "lead" || parts[0] === "contact" || parts[0] === "bot" ? parts.slice(1) : parts;
  for (const part of rest) {
    value = (value as Record<string, unknown> | null | undefined)?.[part];
    if (value === undefined) return "";
  }
  return value ?? "";
}

export function render(template: string, ctx: EngineContext, vars: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_m, path: string) =>
    String(lookup(path, ctx, vars)),
  );
}

function validValue(step: DialogStep, value: string): boolean {
  if (!value) return false;
  switch (step.kind) {
    case "email":
      return EMAIL_RE.test(value);
    case "phone":
      return PHONE_RE.test(value);
    case "regex": {
      try {
        return new RegExp(step.re ?? ".*").test(value);
      } catch {
        return false;
      }
    }
    default:
      return true;
  }
}

/**
 * Run one pass of the session. If the session is waiting for a reply, the
 * current step consumes `reply` first. Returns what the runtime must do
 * (send messages, apply actions) — pure function over (session, step), so it
 * is fully unit-testable and simulatable.
 */
export function runDialogOnce(
  bot: DialogBot,
  session: SessionState,
  reply: string | undefined,
  ctx: EngineContext,
): EngineOutcome {
  const vars: Record<string, unknown> = { ...session.variables };
  if (reply !== undefined) vars["_last_reply"] = reply;
  const sent: string[] = [];
  const actions: BotAction[] = [];
  let current = session.currentStep;
  // A reply feeds exactly the step that was waiting when the run started.
  // After a goto loop revisits it, the reply must not be re-consumed.
  let replyUsed = false;
  const wasWaitingHere = (index: number): boolean =>
    reply !== undefined && !replyUsed && session.waitingStep === index;

  const maxIterations = 200;
  let iterations = 0;
  while (current >= 0 && current < bot.steps.length) {
    if (++iterations > maxIterations) {
      return { session: { ...session, state: "failed", variables: vars }, sent, actions, finished: false, error: "step_loop_exceeded" };
    }
    const step = bot.steps[current]!;
    switch (step.t) {
      case "say": {
        if (step.text) sent.push(render(step.text, ctx, vars));
        current += 1;
        continue;
      }
      case "ask": {
        if (session.state === "active" && wasWaitingHere(current)) {
          if (step.var) vars[step.var] = reply as string;
          replyUsed = true;
          current += 1;
          continue;
        }
        if (step.text) sent.push(render(step.text, ctx, vars));
        return { session: { ...session, currentStep: current, variables: vars, waitingStep: current }, sent, actions, finished: false };
      }
      case "buttons": {
        if (wasWaitingHere(current)) {
          const normalized = (reply as string).trim().toLowerCase();
          const chosen = (step.options ?? []).find((o) => o.toLowerCase() === normalized || normalized.includes(o.toLowerCase()));
          if (chosen) {
            vars["_choice"] = chosen;
            replyUsed = true;
            current += 1;
            continue;
          }
          // unmatched reply: re-ask once (stay on the step)
          if (step.text) sent.push(render(step.text, ctx, vars));
          return { session: { ...session, currentStep: current, variables: vars, waitingStep: current }, sent, actions, finished: false };
        }
        if (step.text) sent.push(render(step.text, ctx, vars));
        if (step.options?.length) sent.push(step.options.join("\n"));
        return { session: { ...session, currentStep: current, variables: vars, waitingStep: current }, sent, actions, finished: false };
      }
      case "set_lead_field": {
        actions.push({ kind: "set_lead_field", key: step.key ?? "field", value: render(step.value ?? "", ctx, vars) });
        current += 1;
        continue;
      }
      case "set_tag": {
        actions.push({ kind: "add_tag", value: render(step.value ?? "", ctx, vars) });
        current += 1;
        continue;
      }
      case "remove_tag": {
        actions.push({ kind: "remove_tag", value: render(step.value ?? "", ctx, vars) });
        current += 1;
        continue;
      }
      case "move_stage": {
        actions.push({ kind: "move_stage", stageId: step.stageId, stageName: step.stageName });
        current += 1;
        continue;
      }
      case "create_task": {
        actions.push({ kind: "create_task", title: render(step.title ?? step.text ?? "Task", ctx, vars) });
        current += 1;
        continue;
      }
      case "add_note": {
        actions.push({ kind: "add_note", text: render(step.text ?? "", ctx, vars) });
        current += 1;
        continue;
      }
      case "assign": {
        actions.push({ kind: "assign", userId: step.userId });
        current += 1;
        continue;
      }
      case "condition": {
        const left = String(lookup(step.var ?? "", ctx, vars));
        const right = render(step.value ?? "", ctx, vars);
        let ok = false;
        if (step.op === "eq") ok = left === right;
        else if (step.op === "ne") ok = left !== right;
        else if (step.op === "contains") ok = left.includes(right);
        current = ok ? (step.then ?? current + 1) : (step.else ?? current + 1);
        continue;
      }
      case "validate": {
        const value = String(lookup(step.var ?? "_last_reply", ctx, vars));
        const ok = validValue(step, value);
        current = ok ? (step.on_pass ?? current + 1) : (step.on_fail ?? current + 1);
        continue;
      }
      case "find_contact": {
        actions.push({ kind: "find_contact", var: step.var });
        // runtime fills vars[_find] before navigating forward; engine
        // consumes one find result per pass
        current += 1;
        continue;
      }
      case "goto": {
        current = step.step ?? current + 1;
        continue;
      }
      case "wait": {
        return { session: { ...session, currentStep: current, variables: vars, waitingStep: current }, sent, actions, finished: false };
      }
      case "stop": {
        return { session: { ...session, state: "finished", variables: vars }, sent, actions, finished: true };
      }
      default: {
        return { session: { ...session, state: "failed", variables: vars }, sent, actions, finished: false, error: `unknown_step_${String(step.t)}` };
      }
    }
  }
  return { session: { ...session, state: "finished", currentStep: current, variables: vars }, sent, actions, finished: true };
}

/** Shape-check a step list (used by CRUD + simulator). */
export function validateSteps(steps: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!Array.isArray(steps)) return { ok: false, errors: ["steps must be an array"] };
  const types = new Set<string>(["say","buttons","ask","set_lead_field","set_tag","remove_tag","move_stage","create_task","add_note","assign","condition","validate","find_contact","goto","wait","stop"]);
  steps.forEach((raw, i) => {
    const step = raw as DialogStep;
    if (!step || typeof step !== "object" || !types.has(step.t)) {
      errors.push(`step ${i}: unknown type`);
      return;
    }
    if (step.t === "say" && !step.text) errors.push(`step ${i}: text required`);
    if (step.t === "ask" && !step.var) errors.push(`step ${i}: var required`);
    if (step.t === "buttons" && !step.text) errors.push(`step ${i}: text required`);
    if (step.t === "goto" && typeof step.step !== "number") errors.push(`step ${i}: step index required`);
    if (step.t === "validate" && (step.kind === "regex" && !step.re)) errors.push(`step ${i}: re required for regex validation`);
  });
  return { ok: errors.length === 0, errors };
}
