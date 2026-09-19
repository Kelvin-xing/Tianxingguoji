import type { RequestAccessActor } from "../../access/public.ts";

export type AuditReadScope = "business" | "security";

export interface AuditReadQuery {
  readonly organizationId: string;
  readonly actor: RequestAccessActor;
  readonly scope: AuditReadScope;
  readonly limit: number;
  readonly before: string | null;
}

export interface AuditReadRow {
  readonly id: string;
  readonly eventType: string;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly outcome: "succeeded" | "denied" | "failed";
  readonly requestId: string;
  readonly occurredAt: string;
  readonly actorUserId: string | null;
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
}

export type AuditReadRepository = {
  list(input: AuditReadQuery): Promise<readonly AuditReadRow[]>;
};

export class AuditReadError extends Error {
  readonly code: "FORBIDDEN" | "INVALID";

  constructor(code: "FORBIDDEN" | "INVALID") {
    super(`Audit read rejected ${code}.`);
    this.name = "AuditReadError";
    this.code = code;
  }
}

export function assertAuditReadQuery(input: AuditReadQuery): void {
  if (!input.actor || input.actor.organizationId !== input.organizationId ||
      !["business", "security"].includes(input.scope) ||
      !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100 ||
      (input.before !== null && !Number.isFinite(Date.parse(input.before)))) {
    throw new AuditReadError("INVALID");
  }
  const principal = input.actor.trialPrincipal;
  if (principal) {
    if (!principal.active || principal.userId !== input.actor.userId || principal.organizationId !== input.organizationId) {
      throw new AuditReadError("FORBIDDEN");
    }
    if (input.scope === "security" && principal.level !== "founder") throw new AuditReadError("FORBIDDEN");
    return;
  }
  const roles = input.actor.roles ?? [];
  if (input.scope === "security" && !roles.includes("founder")) throw new AuditReadError("FORBIDDEN");
  if (input.scope === "business" && !roles.some((role) => ["founder", "admin", "advisor"].includes(role))) {
    throw new AuditReadError("FORBIDDEN");
  }
}

export function auditEventVisibleToTrialActor(input: Readonly<{
  readonly level: "founder" | "l1" | "l2" | "l3";
  readonly actorUserId: string;
  readonly eventActorUserId: string | null;
  readonly eventType: string;
  readonly scope: AuditReadScope;
}>): boolean {
  if (input.scope === "security") return input.level === "founder";
  if (input.level === "founder" || input.level === "l1") return true;
  if (input.level === "l3") return input.eventActorUserId === input.actorUserId && input.eventType.startsWith("tasks.");
  // Category facts are not part of the generic audit envelope. Until an event
  // carries an authoritative category, L2 sees only its own business actions.
  return input.eventActorUserId === input.actorUserId;
}
