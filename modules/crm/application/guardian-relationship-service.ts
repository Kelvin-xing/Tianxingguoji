import { randomUUID } from "node:crypto";

import { hasRequestCapability, type RequestAccessActor } from "../../access/public.ts";
import {
  buildAtomicMutationEffects,
  buildAuditEvent,
  buildOutboxMessage,
  type MutationEffectBundle,
} from "../../audit/public.ts";
import { hashRequestPayload, validateIdempotencyKey } from "../../shared/public.ts";
import {
  isPrimaryGuardianRelationshipType,
  type PrimaryGuardianRelationshipType,
} from "../domain/contract.ts";
import { validateRelationshipDescription } from "../domain/approved-p2-contract.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HANDOFF_REASON = "guardian.primary.handoff" as const;
const END_REASON = "guardian.relationship.ended" as const;
export interface EndGuardianRelationshipCommand {
  readonly studentId: string;
  readonly relationshipId: string;
  readonly expectedRecordVersion: number;
  readonly requestId: string;
  readonly idempotencyKey: string;
}
export interface EndGuardianRelationshipResult {
  readonly relationshipId: string;
  readonly studentId: string;
  readonly status: "ended";
  readonly endsAt: string;
  readonly recordVersion: number;
  readonly occurredAt: string;
}

export interface GuardianContactHint {
  readonly id: string;
  readonly displayName: string;
  readonly emailHint: string | null;
  readonly phoneHint: string | null;
}

export interface GuardianRelationshipResult {
  readonly relationshipId: string;
  readonly studentId: string;
  readonly guardianId: string;
  readonly relationshipType: PrimaryGuardianRelationshipType;
  readonly relationshipDescription?: string | null;
  readonly isLegalGuardian: boolean;
  readonly isPrimaryContact: boolean;
  readonly isEmergencyContact: boolean;
  readonly isBillingContact: boolean;
  readonly notificationConsent: boolean;
  readonly startsAt: string;
  readonly endsAt?: string | null;
  readonly recordVersion: number;
}

export interface GuardianRelationshipsView {
  readonly student: Readonly<{ id: string; displayName: string }>;
  readonly relationships: readonly Readonly<{
    relationship: GuardianRelationshipResult;
    guardian: GuardianContactHint;
  }>[];
}

export interface PrimaryGuardianHandoffResult {
  readonly relationship: GuardianRelationshipResult;
  readonly closedRelationshipIds: Readonly<{
    previousPrimary: string;
    successorSecondary: string;
  }>;
}

export interface AttachGuardianCommand {
  readonly studentId: string;
  readonly guardianId: string;
  readonly relationshipType: PrimaryGuardianRelationshipType;
  readonly relationshipDescription?: string | null;
  readonly isLegalGuardian: boolean;
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
  readonly requestId: string;
  readonly idempotencyKey: string;
}

export interface GuardianRelationshipRepository {
  endRelationship(input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly command: EndGuardianRelationshipCommand;
    readonly reason: typeof END_REASON;
    readonly idempotencyRecordId: string;
    readonly requestHash: string;
    readonly occurredAt: string;
    readonly effects: MutationEffectBundle;
  }): Promise<EndGuardianRelationshipResult>;
  listHistory(input: { readonly organizationId:string; readonly actorUserId:string; readonly studentId:string }): Promise<GuardianRelationshipsView | null>;
  listCurrent(input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly studentId: string;
  }): Promise<GuardianRelationshipsView | null>;
  searchGuardians(input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly studentId: string;
    readonly query: string;
  }): Promise<readonly GuardianContactHint[] | null>;
  createRelationship(input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly studentId: string;
    readonly guardianId: string;
    readonly relationshipId: string;
    readonly relationshipType: PrimaryGuardianRelationshipType;
    readonly relationshipDescription: string | null;
    readonly isLegalGuardian: boolean;
    readonly isEmergencyContact: boolean;
    readonly isBillingContact: boolean;
    readonly notificationConsent: boolean;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly effects: MutationEffectBundle;
  }): Promise<GuardianRelationshipResult>;
  handoffPrimaryContact(input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly studentId: string;
    readonly successorGuardianId: string;
    readonly relationshipId: string;
    readonly expectedPrimaryRecordVersion: number;
    readonly reason: typeof HANDOFF_REASON;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly effects: MutationEffectBundle;
  }): Promise<PrimaryGuardianHandoffResult>;
}

export type GuardianRelationshipErrorCode =
  | "GUARDIAN_RELATIONSHIP_INVALID"
  | "GUARDIAN_RELATIONSHIP_FORBIDDEN"
  | "GUARDIAN_RELATIONSHIP_STUDENT_NOT_FOUND"
  | "GUARDIAN_RELATIONSHIP_GUARDIAN_NOT_FOUND"
  | "GUARDIAN_RELATIONSHIP_PRIMARY_REQUIRED"
  | "GUARDIAN_RELATIONSHIP_CURRENT_PAIR_EXISTS"
  | "GUARDIAN_RELATIONSHIP_PRIMARY_CONFLICT"
  | "GUARDIAN_RELATIONSHIP_STALE_VERSION"
  | "GUARDIAN_RELATIONSHIP_IDEMPOTENCY_KEY_REUSED"
  | "GUARDIAN_RELATIONSHIP_IDEMPOTENCY_IN_PROGRESS"
  | "GUARDIAN_RELATIONSHIP_UNAVAILABLE"
  | "GUARDIAN_RELATIONSHIP_NOT_FOUND"
  | "GUARDIAN_RELATIONSHIP_PRIMARY_CANNOT_END";

export class GuardianRelationshipError extends Error {
  readonly code: GuardianRelationshipErrorCode;

  constructor(code: GuardianRelationshipErrorCode) {
    super(`Guardian relationship rejected ${code}.`);
    this.name = "GuardianRelationshipError";
    this.code = code;
  }
}

const ERROR_CODES = new Set<GuardianRelationshipErrorCode>([
  "GUARDIAN_RELATIONSHIP_INVALID",
  "GUARDIAN_RELATIONSHIP_FORBIDDEN",
  "GUARDIAN_RELATIONSHIP_STUDENT_NOT_FOUND",
  "GUARDIAN_RELATIONSHIP_GUARDIAN_NOT_FOUND",
  "GUARDIAN_RELATIONSHIP_PRIMARY_REQUIRED",
  "GUARDIAN_RELATIONSHIP_CURRENT_PAIR_EXISTS",
  "GUARDIAN_RELATIONSHIP_PRIMARY_CONFLICT",
  "GUARDIAN_RELATIONSHIP_STALE_VERSION",
  "GUARDIAN_RELATIONSHIP_IDEMPOTENCY_KEY_REUSED",
  "GUARDIAN_RELATIONSHIP_IDEMPOTENCY_IN_PROGRESS",
  "GUARDIAN_RELATIONSHIP_UNAVAILABLE",
  "GUARDIAN_RELATIONSHIP_NOT_FOUND", "GUARDIAN_RELATIONSHIP_PRIMARY_CANNOT_END",
]);

export function isGuardianRelationshipError(
  error: unknown,
  code?: GuardianRelationshipErrorCode,
): error is GuardianRelationshipError {
  if (!(error instanceof Error) || error.name !== "GuardianRelationshipError") return false;
  const candidate = (error as Error & { readonly code?: unknown }).code;
  return typeof candidate === "string" && ERROR_CODES.has(candidate as GuardianRelationshipErrorCode) &&
    (code === undefined || candidate === code);
}

export class GuardianRelationshipService {
  private readonly repository: GuardianRelationshipRepository;
  private readonly createId: () => string;
  private readonly nowMs: () => number;

  constructor(
    repository: GuardianRelationshipRepository,
    createId: () => string = randomUUID,
    nowMs: () => number = Date.now,
  ) {
    this.repository = repository;
    this.createId = createId;
    this.nowMs = nowMs;
  }

  async listCurrent(actor: RequestAccessActor, studentId: string): Promise<GuardianRelationshipsView> {
    assertAuthorized(actor, "students.read");
    assertUuid(studentId);
    const result = await this.repository.listCurrent({
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      studentId,
    });
    if (!result) throw new GuardianRelationshipError("GUARDIAN_RELATIONSHIP_STUDENT_NOT_FOUND");
    return result;
  }

  async listHistory(actor: RequestAccessActor, studentId: string): Promise<GuardianRelationshipsView> {
    assertAuthorized(actor, "students.read"); assertUuid(studentId);
    const result = await this.repository.listHistory({ organizationId: actor.organizationId, actorUserId: actor.userId, studentId });
    if (!result) throw new GuardianRelationshipError("GUARDIAN_RELATIONSHIP_STUDENT_NOT_FOUND");
    return result;
  }

  async endRelationship(input: {
    readonly actor: RequestAccessActor;
    readonly command: EndGuardianRelationshipCommand;
  }): Promise<EndGuardianRelationshipResult> {
    assertAuthorized(input.actor, "students.guardians.manage");
    assertEndCommand(input.command);
    const [idempotencyRecordId, auditId, outboxId] = createIds(this.createId, 3) as [string, string, string];
    const occurredAt = nowIso(this.nowMs);
    const requestHash = hashRequestPayload({
      student_id: input.command.studentId,
      relationship_id: input.command.relationshipId,
      expected_record_version: input.command.expectedRecordVersion,
      reason: END_REASON,
    });
    const audit = buildAuditEvent({
      id: auditId, organizationId: input.actor.organizationId, actorUserId: input.actor.userId,
      actorKind: "user", eventType: "crm.guardian_relationship_ended", eventVersion: 1,
      action: "end", resourceType: "StudentGuardianRelationship", resourceId: input.command.relationshipId,
      outcome: "succeeded", requestId: input.command.requestId, occurredAt,
      metadata: {
        status: "ended", previous_version: input.command.expectedRecordVersion,
        next_version: input.command.expectedRecordVersion + 1, reason_code: END_REASON,
        request_id: input.command.requestId,
      },
    });
    const outbox = buildOutboxMessage({
      id: outboxId, auditEventId: auditId, organizationId: input.actor.organizationId,
      aggregateType: "StudentGuardianRelationship", aggregateId: input.command.relationshipId,
      eventType: "crm.guardian_relationship_ended", eventVersion: 1,
      idempotencyKey: `guardian-relationship-end-${idempotencyRecordId}`,
      requestId: input.command.requestId,
      payload: {
        aggregate_id: input.command.relationshipId, status: "ended",
        previous_record_version: input.command.expectedRecordVersion,
        record_version: input.command.expectedRecordVersion + 1, reason_code: END_REASON,
        request_id: input.command.requestId,
      },
      availableAt: occurredAt, createdAt: occurredAt,
    });
    return this.repository.endRelationship({
      organizationId: input.actor.organizationId, actorUserId: input.actor.userId,
      command: input.command, reason: END_REASON, idempotencyRecordId, requestHash,
      occurredAt, effects: buildAtomicMutationEffects({ audit, outbox }),
    });
  }

  async searchGuardians(input: {
    readonly actor: RequestAccessActor;
    readonly studentId: string;
    readonly query: string;
  }): Promise<readonly GuardianContactHint[]> {
    assertAuthorized(input.actor, "students.guardians.manage");
    assertUuid(input.studentId);
    const query = typeof input.query === "string" ? input.query.trim() : "";
    if (query.length < 2 || query.length > 100) {
      throw new GuardianRelationshipError("GUARDIAN_RELATIONSHIP_INVALID");
    }
    const result = await this.repository.searchGuardians({
      organizationId: input.actor.organizationId,
      actorUserId: input.actor.userId,
      studentId: input.studentId,
      query,
    });
    if (!result) throw new GuardianRelationshipError("GUARDIAN_RELATIONSHIP_STUDENT_NOT_FOUND");
    return result;
  }

  async attachGuardian(input: {
    readonly actor: RequestAccessActor;
    readonly command: AttachGuardianCommand;
  }): Promise<GuardianRelationshipResult> {
    assertAuthorized(input.actor, "students.guardians.manage");
    assertAttachCommand(input.command);
    const [relationshipId, auditId, outboxId] = createIds(this.createId, 3) as [string, string, string];
    const occurredAt = nowIso(this.nowMs);
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
      metadata: { effect_type: "guardian.relationship.created", record_version: 1, status: "current" },
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
        effect_type: "guardian.relationship.created",
        operation: "create",
        record_version: 1,
        request_id: input.command.requestId,
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
      relationshipType: input.command.relationshipType,
      relationshipDescription: input.command.relationshipDescription ?? null,
      isLegalGuardian: input.command.isLegalGuardian,
      isEmergencyContact: input.command.isEmergencyContact,
      isBillingContact: input.command.isBillingContact,
      notificationConsent: input.command.notificationConsent,
      idempotencyKey: input.command.idempotencyKey,
      requestHash: hashRequestPayload({
        guardianId: input.command.guardianId,
        isBillingContact: input.command.isBillingContact,
        isEmergencyContact: input.command.isEmergencyContact,
        isLegalGuardian: input.command.isLegalGuardian,
        isPrimaryContact: false,
        notificationConsent: input.command.notificationConsent,
        relationshipType: input.command.relationshipType,
        relationshipDescription: input.command.relationshipDescription ?? null,
        studentId: input.command.studentId,
      }),
      effects: buildAtomicMutationEffects({ audit, outbox }),
    });
  }

  async handoffPrimaryContact(input: {
    readonly actor: RequestAccessActor;
    readonly command: HandoffPrimaryContactCommand;
  }): Promise<PrimaryGuardianHandoffResult> {
    assertAuthorized(input.actor, "students.guardians.manage");
    assertHandoffCommand(input.command);
    const [relationshipId, auditId, outboxId] = createIds(this.createId, 3) as [string, string, string];
    const occurredAt = nowIso(this.nowMs);
    const eventType = "crm.student_guardian_primary_handed_off";
    const nextVersion = input.command.expectedPrimaryRecordVersion + 1;
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
        effect_type: "guardian.primary.handoff",
        previous_version: input.command.expectedPrimaryRecordVersion,
        next_version: nextVersion,
        reason_code: HANDOFF_REASON,
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
        effect_type: "guardian.primary.handoff",
        operation: "handoff",
        reason_code: HANDOFF_REASON,
        record_version: nextVersion,
        request_id: input.command.requestId,
        status: "pending",
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
      reason: HANDOFF_REASON,
      idempotencyKey: input.command.idempotencyKey,
      requestHash: hashRequestPayload({
        expectedPrimaryRecordVersion: input.command.expectedPrimaryRecordVersion,
        reason: HANDOFF_REASON,
        studentId: input.command.studentId,
        successorGuardianId: input.command.successorGuardianId,
      }),
      effects: buildAtomicMutationEffects({ audit, outbox }),
    });
  }
}

function assertAuthorized(actor: RequestAccessActor, capability: "students.read" | "students.guardians.manage"): void {
  if (!UUID.test(actor.organizationId) || !UUID.test(actor.userId) ||
      !hasRequestCapability(actor, capability)) {
    throw new GuardianRelationshipError("GUARDIAN_RELATIONSHIP_FORBIDDEN");
  }
}

function assertAttachCommand(command: AttachGuardianCommand): void {
  if (!UUID.test(command.studentId) || !UUID.test(command.guardianId) ||
      !isPrimaryGuardianRelationshipType(command.relationshipType) ||
      !validateRelationshipDescription({ relationshipType: command.relationshipType,
        relationshipDescription: command.relationshipDescription ?? null }) ||
      !REQUEST_ID.test(command.requestId) ||
      [command.isLegalGuardian, command.isEmergencyContact, command.isBillingContact,
        command.notificationConsent].some((value) => typeof value !== "boolean")) {
    throw new GuardianRelationshipError("GUARDIAN_RELATIONSHIP_INVALID");
  }
  assertIdempotencyKey(command.idempotencyKey);
}

function assertHandoffCommand(command: HandoffPrimaryContactCommand): void {
  if (!UUID.test(command.studentId) || !UUID.test(command.successorGuardianId) ||
      !Number.isSafeInteger(command.expectedPrimaryRecordVersion) ||
      command.expectedPrimaryRecordVersion < 1 || !REQUEST_ID.test(command.requestId)) {
    throw new GuardianRelationshipError("GUARDIAN_RELATIONSHIP_INVALID");
  }
  assertIdempotencyKey(command.idempotencyKey);
}

function assertEndCommand(command: EndGuardianRelationshipCommand): void {
  if (!UUID.test(command.studentId) || !UUID.test(command.relationshipId) ||
      !Number.isSafeInteger(command.expectedRecordVersion) || command.expectedRecordVersion < 1 ||
      !REQUEST_ID.test(command.requestId)) {
    throw new GuardianRelationshipError("GUARDIAN_RELATIONSHIP_INVALID");
  }
  assertIdempotencyKey(command.idempotencyKey);
}

function assertIdempotencyKey(value: string): void {
  try {
    validateIdempotencyKey(value);
  } catch {
    throw new GuardianRelationshipError("GUARDIAN_RELATIONSHIP_INVALID");
  }
}

function assertUuid(value: string): void {
  if (!UUID.test(value)) throw new GuardianRelationshipError("GUARDIAN_RELATIONSHIP_INVALID");
}

function createIds(createId: () => string, count: number): string[] {
  const ids = Array.from({ length: count }, createId);
  for (const id of ids) assertUuid(id);
  return ids;
}

function nowIso(nowMs: () => number): string {
  const value = nowMs();
  if (!Number.isFinite(value) || value <= 0) {
    throw new GuardianRelationshipError("GUARDIAN_RELATIONSHIP_INVALID");
  }
  return new Date(value).toISOString();
}
