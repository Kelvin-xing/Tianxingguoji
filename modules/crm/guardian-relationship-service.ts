import { randomUUID } from "node:crypto";

import {
  buildAtomicMutationEffects,
  buildAuditEvent,
  buildOutboxMessage,
  type MutationEffectBundle,
} from "../audit/contract.ts";
import type { IdentitySessionActor } from "../identity/session-repository.ts";
import { hashRequestPayload, validateIdempotencyKey } from "../shared/idempotency.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_CODE = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;

export interface GuardianRelationshipClock {
  nowMs(): number;
}

export interface AttachGuardianCommand {
  readonly studentId: string;
  readonly guardianId: string;
  readonly relationshipType: string;
  readonly isLegalGuardian: boolean;
  readonly isPrimaryContact: boolean;
  readonly isEmergencyContact: boolean;
  readonly isBillingContact: boolean;
  readonly notificationConsent: boolean;
  readonly requestId: string;
  readonly idempotencyKey: string;
}

export interface HandoffPrimaryContactCommand {
  readonly studentId: string;
  readonly successorGuardianId: string;
  readonly expectedPrimaryRecordVersion: number;
  readonly reason: string;
  readonly requestId: string;
  readonly idempotencyKey: string;
}

export interface GuardianRelationshipResult {
  readonly relationshipId: string;
  readonly studentId: string;
  readonly guardianId: string;
  readonly relationshipType: string;
  readonly isLegalGuardian: boolean;
  readonly isPrimaryContact: boolean;
  readonly isEmergencyContact: boolean;
  readonly isBillingContact: boolean;
  readonly notificationConsent: boolean;
  readonly startsAtMs: number;
  readonly endsAtMs: number | null;
  readonly recordVersion: number;
}

export interface GuardianRelationshipRepository {
  /**
   * Resolves Student/Guardian state, authorization-sensitive relationship
   * reads, idempotency, relationship/audit/outbox writes in one transaction.
   */
  createRelationship(input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly studentId: string;
    readonly guardianId: string;
    readonly relationshipId: string;
    readonly relationshipType: string;
    readonly isLegalGuardian: boolean;
    readonly isPrimaryContact: boolean;
    readonly isEmergencyContact: boolean;
    readonly isBillingContact: boolean;
    readonly notificationConsent: boolean;
    readonly requestId: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly createdAtMs: number;
    readonly effects: MutationEffectBundle;
  }): Promise<GuardianRelationshipResult>;
  /**
   * Locks the Student/current relationship rows, validates the expected primary
   * version, closes prior rows, and inserts successor/audit/outbox rows in one
   * transaction. A stale contender must not overwrite the winning handoff.
   */
  handoffPrimaryContact(input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly studentId: string;
    readonly successorGuardianId: string;
    readonly relationshipId: string;
    readonly expectedPrimaryRecordVersion: number;
    readonly reason: string;
    readonly requestId: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly createdAtMs: number;
    readonly effects: MutationEffectBundle;
  }): Promise<GuardianRelationshipResult>;
}

export type GuardianRelationshipErrorCode =
  | "GUARDIAN_RELATIONSHIP_INVALID"
  | "GUARDIAN_RELATIONSHIP_ADVISOR_REQUIRED"
  | "GUARDIAN_RELATIONSHIP_STUDENT_NOT_FOUND"
  | "GUARDIAN_RELATIONSHIP_GUARDIAN_NOT_FOUND"
  | "GUARDIAN_RELATIONSHIP_PRIMARY_REQUIRED"
  | "GUARDIAN_RELATIONSHIP_CURRENT_PAIR_EXISTS"
  | "GUARDIAN_RELATIONSHIP_PRIMARY_CONFLICT"
  | "GUARDIAN_RELATIONSHIP_STALE_VERSION"
  | "GUARDIAN_RELATIONSHIP_IDEMPOTENCY_KEY_REUSED"
  | "GUARDIAN_RELATIONSHIP_IDEMPOTENCY_IN_PROGRESS";

export class GuardianRelationshipError extends Error {
  readonly code: GuardianRelationshipErrorCode;

  constructor(code: GuardianRelationshipErrorCode) {
    super(`Guardian relationship rejected ${code}.`);
    this.name = "GuardianRelationshipError";
    this.code = code;
  }
}

export interface GuardianRelationshipServiceOptions {
  readonly repository: GuardianRelationshipRepository;
  readonly clock?: GuardianRelationshipClock;
  readonly createId?: () => string;
}

/**
 * Commands are intentionally limited to existing opaque Guardian IDs. Contact
 * matching and any corrective merge remain outside this P2-01 boundary.
 */
export class GuardianRelationshipService {
  private readonly repository: GuardianRelationshipRepository;
  private readonly clock: GuardianRelationshipClock;
  private readonly createId: () => string;

  constructor(options: GuardianRelationshipServiceOptions) {
    this.repository = options.repository;
    this.clock = options.clock ?? { nowMs: () => Date.now() };
    this.createId = options.createId ?? randomUUID;
  }

  async attachGuardian(input: {
    readonly actor: IdentitySessionActor;
    readonly command: AttachGuardianCommand;
  }): Promise<GuardianRelationshipResult> {
    assertAdvisor(input.actor);
    assertAttachCommand(input.command);

    const relationshipId = this.createId();
    const auditId = this.createId();
    const outboxId = this.createId();
    for (const id of [relationshipId, auditId, outboxId]) assertUuid(id);

    const createdAtMs = this.clock.nowMs();
    if (!Number.isFinite(createdAtMs) || createdAtMs <= 0) {
      throw new GuardianRelationshipError("GUARDIAN_RELATIONSHIP_INVALID");
    }
    const occurredAt = new Date(createdAtMs).toISOString();
    const eventType = "crm.student_guardian_relationship_created";
    const audit = buildAuditEvent({
      id: auditId,
      organizationId: input.actor.organizationId,
      actorUserId: input.actor.userId,
      actorKind: "user",
      eventType,
      eventVersion: 1,
      action: "create",
      resourceType: "StudentGuardianRelationship",
      resourceId: relationshipId,
      outcome: "succeeded",
      requestId: input.command.requestId,
      occurredAt,
      metadata: {
        record_version: 1,
        status: "current",
        effect_type: "guardian.relationship.created",
      },
    });
    const outbox = buildOutboxMessage({
      id: outboxId,
      auditEventId: auditId,
      organizationId: input.actor.organizationId,
      aggregateType: "StudentGuardianRelationship",
      aggregateId: relationshipId,
      eventType,
      eventVersion: 1,
      idempotencyKey: `guardian-relationship-create-${outboxId}`,
      requestId: input.command.requestId,
      payload: {
        aggregate_id: relationshipId,
        record_version: 1,
        request_id: input.command.requestId,
        effect_type: "guardian.relationship.created",
        operation: "create",
        status: "pending",
      },
      availableAt: occurredAt,
      createdAt: occurredAt,
    });

    return this.repository.createRelationship({
      organizationId: input.actor.organizationId,
      actorUserId: input.actor.userId,
      studentId: input.command.studentId,
      guardianId: input.command.guardianId,
      relationshipId,
      relationshipType: input.command.relationshipType.trim(),
      isLegalGuardian: input.command.isLegalGuardian,
      isPrimaryContact: input.command.isPrimaryContact,
      isEmergencyContact: input.command.isEmergencyContact,
      isBillingContact: input.command.isBillingContact,
      notificationConsent: input.command.notificationConsent,
      requestId: input.command.requestId,
      idempotencyKey: input.command.idempotencyKey,
      requestHash: hashRequestPayload({
        guardianId: input.command.guardianId,
        isBillingContact: input.command.isBillingContact,
        isEmergencyContact: input.command.isEmergencyContact,
        isLegalGuardian: input.command.isLegalGuardian,
        isPrimaryContact: input.command.isPrimaryContact,
        notificationConsent: input.command.notificationConsent,
        relationshipType: input.command.relationshipType.trim(),
        studentId: input.command.studentId,
      }),
      createdAtMs,
      effects: buildAtomicMutationEffects({ audit, outbox }),
    });
  }

  async handoffPrimaryContact(input: {
    readonly actor: IdentitySessionActor;
    readonly command: HandoffPrimaryContactCommand;
  }): Promise<GuardianRelationshipResult> {
    assertAdvisor(input.actor);
    assertHandoffCommand(input.command);

    const relationshipId = this.createId();
    const auditId = this.createId();
    const outboxId = this.createId();
    for (const id of [relationshipId, auditId, outboxId]) assertUuid(id);

    const createdAtMs = this.clock.nowMs();
    if (!Number.isFinite(createdAtMs) || createdAtMs <= 0) {
      throw new GuardianRelationshipError("GUARDIAN_RELATIONSHIP_INVALID");
    }
    const occurredAt = new Date(createdAtMs).toISOString();
    const eventType = "crm.student_guardian_primary_handed_off";
    const audit = buildAuditEvent({
      id: auditId,
      organizationId: input.actor.organizationId,
      actorUserId: input.actor.userId,
      actorKind: "user",
      eventType,
      eventVersion: 1,
      action: "handoff",
      resourceType: "StudentGuardianRelationship",
      resourceId: relationshipId,
      outcome: "succeeded",
      requestId: input.command.requestId,
      occurredAt,
      metadata: {
        previous_version: input.command.expectedPrimaryRecordVersion,
        next_version: 1,
        reason_code: input.command.reason,
        effect_type: "guardian.primary.handoff",
      },
    });
    const outbox = buildOutboxMessage({
      id: outboxId,
      auditEventId: auditId,
      organizationId: input.actor.organizationId,
      aggregateType: "StudentGuardianRelationship",
      aggregateId: relationshipId,
      eventType,
      eventVersion: 1,
      idempotencyKey: `guardian-primary-handoff-${outboxId}`,
      requestId: input.command.requestId,
      payload: {
        aggregate_id: relationshipId,
        record_version: 1,
        request_id: input.command.requestId,
        effect_type: "guardian.primary.handoff",
        operation: "handoff",
        status: "pending",
        reason_code: input.command.reason,
      },
      availableAt: occurredAt,
      createdAt: occurredAt,
    });

    return this.repository.handoffPrimaryContact({
      organizationId: input.actor.organizationId,
      actorUserId: input.actor.userId,
      studentId: input.command.studentId,
      successorGuardianId: input.command.successorGuardianId,
      relationshipId,
      expectedPrimaryRecordVersion: input.command.expectedPrimaryRecordVersion,
      reason: input.command.reason,
      requestId: input.command.requestId,
      idempotencyKey: input.command.idempotencyKey,
      requestHash: hashRequestPayload({
        expectedPrimaryRecordVersion: input.command.expectedPrimaryRecordVersion,
        reason: input.command.reason,
        studentId: input.command.studentId,
        successorGuardianId: input.command.successorGuardianId,
      }),
      createdAtMs,
      effects: buildAtomicMutationEffects({ audit, outbox }),
    });
  }
}

function assertAdvisor(actor: IdentitySessionActor): void {
  if (!UUID.test(actor.organizationId) || !UUID.test(actor.userId) || actor.role !== "advisor") {
    throw new GuardianRelationshipError("GUARDIAN_RELATIONSHIP_ADVISOR_REQUIRED");
  }
}

function assertAttachCommand(command: AttachGuardianCommand): void {
  if (
    !UUID.test(command.studentId) ||
    !UUID.test(command.guardianId) ||
    command.studentId === command.guardianId ||
    !SAFE_CODE.test(command.relationshipType) ||
    !SAFE_CODE.test(command.requestId) ||
    typeof command.isLegalGuardian !== "boolean" ||
    typeof command.isPrimaryContact !== "boolean" ||
    typeof command.isEmergencyContact !== "boolean" ||
    typeof command.isBillingContact !== "boolean" ||
    typeof command.notificationConsent !== "boolean"
  ) {
    throw new GuardianRelationshipError("GUARDIAN_RELATIONSHIP_INVALID");
  }
  try {
    validateIdempotencyKey(command.idempotencyKey);
  } catch {
    throw new GuardianRelationshipError("GUARDIAN_RELATIONSHIP_INVALID");
  }
}

function assertHandoffCommand(command: HandoffPrimaryContactCommand): void {
  if (
    !UUID.test(command.studentId) ||
    !UUID.test(command.successorGuardianId) ||
    !Number.isSafeInteger(command.expectedPrimaryRecordVersion) ||
    command.expectedPrimaryRecordVersion < 1 ||
    !SAFE_CODE.test(command.reason) ||
    !SAFE_CODE.test(command.requestId)
  ) {
    throw new GuardianRelationshipError("GUARDIAN_RELATIONSHIP_INVALID");
  }
  try {
    validateIdempotencyKey(command.idempotencyKey);
  } catch {
    throw new GuardianRelationshipError("GUARDIAN_RELATIONSHIP_INVALID");
  }
}

function assertUuid(value: string): void {
  if (!UUID.test(value)) throw new GuardianRelationshipError("GUARDIAN_RELATIONSHIP_INVALID");
}
