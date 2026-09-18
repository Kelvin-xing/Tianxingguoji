import { randomUUID } from "node:crypto";
import { buildAtomicMutationEffects, buildAuditEvent, buildOutboxMessage, type MutationEffectBundle } from "../../audit/public.ts";
import { hashRequestPayload, validateIdempotencyKey } from "../../shared/public.ts";
import type { AccessContext } from "../domain/authorization.ts";
import { isK12BusinessCategory, isTrialLevel, type K12BusinessCategory, type TrialLevel } from "../domain/trial-policy.ts";

export type TrialMemberErrorCode = "FORBIDDEN" | "INVALID" | "NOT_FOUND" | "STALE_VERSION" | "LAST_FOUNDER_REQUIRED" | "IDEMPOTENCY_CONFLICT" | "UNAVAILABLE";
export class TrialMemberError extends Error {
  readonly code: TrialMemberErrorCode;
  constructor(code: TrialMemberErrorCode) {
    super(`Trial member command rejected: ${code}`);
    this.name = "TrialMemberError";
    this.code = code;
  }
}
export interface TrialMemberView {
  readonly userId: string;
  readonly membershipId: string;
  readonly displayName: string;
  readonly email: string;
  readonly level: TrialLevel | null;
  readonly categories: readonly K12BusinessCategory[];
  readonly status: "active" | "disabled" | null;
  readonly recordVersion: number | null;
}
export interface TrialMemberReceipt {
  readonly userId: string;
  readonly receiptId: string;
  readonly replayed: boolean;
}
export interface TrialMemberMutation {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly targetUserId: string;
  readonly level: TrialLevel;
  readonly categories: readonly K12BusinessCategory[];
  readonly status: "active" | "disabled";
  readonly expectedRecordVersion: number | null;
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly idempotencyId: string;
  readonly roleBindingId: string;
  readonly requestHash: string;
  readonly occurredAt: string;
  readonly effects: MutationEffectBundle;
}
export interface TrialMemberRepository {
  list(input: Readonly<{ organizationId: string; actorUserId: string }>): Promise<readonly TrialMemberView[]>;
  update(input: TrialMemberMutation): Promise<TrialMemberReceipt>;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export class TrialMemberManagementService {
  private readonly repository: TrialMemberRepository;
  constructor(repository: TrialMemberRepository) { this.repository = repository; }

  list(actor: AccessContext): Promise<readonly TrialMemberView[]> {
    assertFounder(actor);
    return this.repository.list({ organizationId: actor.organizationId, actorUserId: actor.userId });
  }

  update(input: Readonly<{
    actor: AccessContext; targetUserId: string;
    command: Readonly<{ level: unknown; categories: unknown; status: unknown; expectedRecordVersion: unknown; requestId: string; idempotencyKey: string }>;
  }>): Promise<TrialMemberReceipt> {
    assertFounder(input.actor);
    const command = input.command;
    if (!UUID.test(input.targetUserId) || !isTrialLevel(command.level) || !Array.isArray(command.categories)
      || !command.categories.every(isK12BusinessCategory) || new Set(command.categories).size !== command.categories.length
      || (command.level !== "l2" && command.categories.length !== 0)
      || !["active", "disabled"].includes(command.status as string)
      || (command.expectedRecordVersion !== null && (!Number.isSafeInteger(command.expectedRecordVersion) || Number(command.expectedRecordVersion) < 1))
      || !REQUEST_ID.test(command.requestId)) throw new TrialMemberError("INVALID");
    try { validateIdempotencyKey(command.idempotencyKey); } catch { throw new TrialMemberError("INVALID"); }
    const categories = Object.freeze([...command.categories].sort());
    const occurredAt = new Date().toISOString();
    const auditId = randomUUID();
    const outboxId = randomUUID();
    const eventType = "access.trial_member.updated";
    const audit = buildAuditEvent({
      id: auditId, organizationId: input.actor.organizationId, actorUserId: input.actor.userId,
      actorKind: "user", eventType, eventVersion: 1, action: "update_trial_member",
      resourceType: "OrganizationMember", resourceId: input.targetUserId, outcome: "succeeded",
      requestId: command.requestId, occurredAt,
      metadata: { effect_type: "trial_member_updated", status: command.status as string },
    });
    const outbox = buildOutboxMessage({
      id: outboxId, auditEventId: auditId, organizationId: input.actor.organizationId,
      aggregateType: "OrganizationMember", aggregateId: input.targetUserId, eventType, eventVersion: 1,
      idempotencyKey: `trial-member-${outboxId}`, requestId: command.requestId,
      payload: { aggregate_id: input.targetUserId, effect_type: "trial_member_updated", status: command.status as string, request_id: command.requestId },
      availableAt: occurredAt, createdAt: occurredAt,
    });
    return this.repository.update({
      organizationId: input.actor.organizationId, actorUserId: input.actor.userId, targetUserId: input.targetUserId,
      level: command.level, categories, status: command.status as "active" | "disabled",
      expectedRecordVersion: command.expectedRecordVersion as number | null,
      requestId: command.requestId, idempotencyKey: command.idempotencyKey,
      idempotencyId: randomUUID(), roleBindingId: randomUUID(), occurredAt,
      requestHash: hashRequestPayload({ target_user_id: input.targetUserId, level: command.level, categories,
        status: command.status as string, expected_record_version: command.expectedRecordVersion as number | null }),
      effects: buildAtomicMutationEffects({ audit, outbox }),
    });
  }
}
function assertFounder(actor: AccessContext): void {
  if (actor.trialPrincipal ? actor.trialPrincipal.level !== "founder" || !actor.trialPrincipal.active
    : !actor.roles.includes("founder")) throw new TrialMemberError("FORBIDDEN");
}
