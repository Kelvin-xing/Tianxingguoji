import { randomUUID } from "node:crypto";

import {
  buildAtomicMutationEffects,
  buildAuditEvent,
  buildOutboxMessage,
  type MutationEffectBundle,
} from "../../audit/public.ts";
import type { IdentitySessionActor } from "../../identity/public.ts";
import { hashRequestPayload, validateIdempotencyKey } from "../../shared/public.ts";
import { evaluateSchoolTargetCreation } from "../domain/contract.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export type SchoolTargetCaseStage =
  | "signed"
  | "background_collection"
  | "school_selection_confirmed"
  | "interview_preparation"
  | "application_submitted"
  | "awaiting_result"
  | "offer_confirmed"
  | "closed";

export type SchoolTargetCreateBlockedReason =
  | "founder_read_only"
  | "case_stage_not_allowed"
  | "no_school_options"
  | null;

export interface CreateSchoolTargetCommand {
  readonly expectedResolutionSha256: string;
  readonly requestId: string;
  readonly idempotencyKey: string;
}

export type SchoolTargetState =
  | "candidate"
  | "preparing"
  | "submitted"
  | "interview"
  | "waitlisted"
  | "accepted"
  | "rejected"
  | "withdrawn";

export interface SchoolTargetItem {
  readonly targetId: string;
  readonly schoolId: string;
  readonly schoolName: string;
  readonly state: SchoolTargetState;
  readonly intakeYear: number;
  readonly admissionType: string;
  readonly recordVersion: number;
  readonly resolvedRevisionId: string;
  readonly resolutionSha256: string;
  readonly createdAt: string;
}

export interface SchoolTargetOption {
  readonly schoolId: string;
  readonly displayName: string;
  readonly resolutionSha256: string;
}

export interface SchoolTargetWorkspaceSnapshot {
  readonly caseId: string;
  readonly caseStage: SchoolTargetCaseStage;
  readonly intakeYear: number;
  readonly admissionType: string;
  readonly items: readonly SchoolTargetItem[];
  readonly schoolOptions: readonly SchoolTargetOption[];
}

export interface SchoolTargetWorkspace extends SchoolTargetWorkspaceSnapshot {
  readonly canCreate: boolean;
  readonly createBlockedReason: SchoolTargetCreateBlockedReason;
}

export type SchoolTargetResult = SchoolTargetItem;

export interface SchoolTargetRepository {
  readSchoolTargetWorkspace(input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly actorRole: "founder" | "advisor";
    readonly caseId: string;
  }): Promise<SchoolTargetWorkspaceSnapshot>;

  /** Rechecks authority and resolves the school inside the write transaction. */
  createSchoolTarget(input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly actorRole: "advisor";
    readonly caseId: string;
    readonly targetId: string;
    readonly schoolId: string;
    readonly proposedResolvedRevisionId: string;
    readonly expectedResolutionSha256: string;
    readonly requestId: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly createdAtMs: number;
    readonly effects: MutationEffectBundle;
  }): Promise<SchoolTargetResult>;
}

export type SchoolTargetErrorCode =
  | "SCHOOL_TARGET_INVALID"
  | "SCHOOL_TARGET_READ_FORBIDDEN"
  | "SCHOOL_TARGET_ADVISOR_REQUIRED"
  | "SCHOOL_TARGET_CASE_NOT_FOUND"
  | "SCHOOL_TARGET_CASE_FORBIDDEN"
  | "SCHOOL_TARGET_STAGE_NOT_ALLOWED"
  | "SCHOOL_TARGET_RESOLUTION_NOT_FOUND"
  | "SCHOOL_TARGET_RESOLUTION_STALE"
  | "SCHOOL_TARGET_IDEMPOTENCY_KEY_REUSED"
  | "SCHOOL_TARGET_IDEMPOTENCY_IN_PROGRESS"
  | "SCHOOL_TARGET_DUPLICATE"
  | "SCHOOL_TARGET_RESOLUTION_INVALID";

export class SchoolTargetError extends Error {
  readonly code: SchoolTargetErrorCode;

  constructor(code: SchoolTargetErrorCode) {
    super(`School target command rejected ${code}.`);
    this.name = "SchoolTargetError";
    this.code = code;
  }
}

export interface SchoolTargetServiceOptions {
  readonly repository: SchoolTargetRepository;
  readonly clock?: SchoolTargetClock;
  readonly createId?: () => string;
}

export interface SchoolTargetClock {
  nowMs(): number;
}

/** Cases owns target facts; Schools owns the resolved school input. */
export class SchoolTargetService {
  private readonly repository: SchoolTargetRepository;
  private readonly clock: SchoolTargetClock;
  private readonly createId: () => string;

  constructor(options: SchoolTargetServiceOptions) {
    this.repository = options.repository;
    this.clock = options.clock ?? { nowMs: () => Date.now() };
    this.createId = options.createId ?? randomUUID;
  }

  async getSchoolTargets(input: {
    readonly actor: IdentitySessionActor;
    readonly caseId: string;
  }): Promise<SchoolTargetWorkspace> {
    const actorRole = assertReadableActor(input.actor);
    assertUuid(input.caseId);
    const snapshot = await this.repository.readSchoolTargetWorkspace({
      organizationId: input.actor.organizationId,
      actorUserId: input.actor.userId,
      actorRole,
      caseId: input.caseId,
    });
    const createBlockedReason: SchoolTargetCreateBlockedReason =
      actorRole === "founder" ? "founder_read_only"
        : snapshot.caseStage !== "background_collection" ? "case_stage_not_allowed"
        : snapshot.schoolOptions.length === 0 ? "no_school_options"
        : null;
    return Object.freeze({
      ...snapshot,
      canCreate: createBlockedReason === null,
      createBlockedReason,
    });
  }

  async createSchoolTarget(input: {
    readonly actor: IdentitySessionActor;
    readonly caseId: string;
    readonly schoolId: string;
    readonly command: CreateSchoolTargetCommand;
  }): Promise<SchoolTargetResult> {
    assertAdvisor(input.actor);
    assertUuid(input.caseId);
    assertUuid(input.schoolId);
    assertCommand(input.command);
    const creation = evaluateSchoolTargetCreation({ initialState: "candidate" });
    if (!creation.allowed) throw new SchoolTargetError("SCHOOL_TARGET_INVALID");

    const targetId = this.createId();
    const proposedResolvedRevisionId = this.createId();
    const auditId = this.createId();
    const outboxId = this.createId();
    for (const id of [targetId, proposedResolvedRevisionId, auditId, outboxId]) assertUuid(id);
    const createdAtMs = validNow(this.clock.nowMs());
    const occurredAt = new Date(createdAtMs).toISOString();
    const eventType = "cases.school_target_created";
    const audit = buildAuditEvent({
      id: auditId,
      organizationId: input.actor.organizationId,
      actorUserId: input.actor.userId,
      actorKind: "user",
      eventType,
      eventVersion: 1,
      action: "create",
      resourceType: "SchoolTarget",
      resourceId: targetId,
      outcome: "succeeded",
      requestId: input.command.requestId,
      occurredAt,
      afterHashSha256: input.command.expectedResolutionSha256,
      metadata: {
        effect_type: "school_target_created",
        record_version: 1,
        status: "candidate",
      },
    });
    const outbox = buildOutboxMessage({
      id: outboxId,
      auditEventId: auditId,
      organizationId: input.actor.organizationId,
      aggregateType: "SchoolTarget",
      aggregateId: targetId,
      eventType,
      eventVersion: 1,
      idempotencyKey: `school-target-${outboxId}`,
      requestId: input.command.requestId,
      payload: {
        aggregate_id: targetId,
        effect_type: "school_target_created",
        record_version: 1,
        request_id: input.command.requestId,
        status: "candidate",
      },
      availableAt: occurredAt,
      createdAt: occurredAt,
    });

    return this.repository.createSchoolTarget({
      organizationId: input.actor.organizationId,
      actorUserId: input.actor.userId,
      actorRole: "advisor",
      caseId: input.caseId,
      targetId,
      schoolId: input.schoolId,
      proposedResolvedRevisionId,
      expectedResolutionSha256: input.command.expectedResolutionSha256,
      requestId: input.command.requestId,
      idempotencyKey: input.command.idempotencyKey,
      requestHash: hashRequestPayload({
        caseId: input.caseId,
        expectedResolutionSha256: input.command.expectedResolutionSha256,
        schoolId: input.schoolId,
      }),
      createdAtMs,
      effects: buildAtomicMutationEffects({ audit, outbox }),
    });
  }
}

function assertReadableActor(actor: IdentitySessionActor): "founder" | "advisor" {
  if (!UUID.test(actor.organizationId) || !UUID.test(actor.userId)) {
    throw new SchoolTargetError("SCHOOL_TARGET_READ_FORBIDDEN");
  }
  if (actor.role === "founder" || actor.role === "advisor") return actor.role;
  throw new SchoolTargetError("SCHOOL_TARGET_READ_FORBIDDEN");
}

function assertAdvisor(actor: IdentitySessionActor): void {
  if (!UUID.test(actor.organizationId) || !UUID.test(actor.userId) || actor.role !== "advisor") {
    throw new SchoolTargetError("SCHOOL_TARGET_ADVISOR_REQUIRED");
  }
}

function assertCommand(command: CreateSchoolTargetCommand): void {
  if (!SHA256.test(command.expectedResolutionSha256) || !REQUEST_ID.test(command.requestId)) {
    throw new SchoolTargetError("SCHOOL_TARGET_INVALID");
  }
  try {
    validateIdempotencyKey(command.idempotencyKey);
  } catch {
    throw new SchoolTargetError("SCHOOL_TARGET_INVALID");
  }
}

function assertUuid(value: string): void {
  if (!UUID.test(value)) throw new SchoolTargetError("SCHOOL_TARGET_INVALID");
}

function validNow(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new SchoolTargetError("SCHOOL_TARGET_INVALID");
  }
  return value;
}
