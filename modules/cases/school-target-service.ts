import { randomUUID } from "node:crypto";

import {
  buildAtomicMutationEffects,
  buildAuditEvent,
  buildOutboxMessage,
  type MutationEffectBundle,
} from "../audit/contract.ts";
import type { IdentitySessionActor } from "../identity/session-repository.ts";
import {
  resolveSchoolTargetView,
  persistResolvedSchoolPin,
  SchoolResolutionError,
  type ResolvedSchoolPin,
  type ResolvedSchoolTargetView,
  type SchoolResolutionSource,
} from "../schools/resolved-view.ts";
import { hashRequestPayload, validateIdempotencyKey } from "../shared/idempotency.ts";
import { evaluateSchoolTargetCreation } from "./contract.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_CODE = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/i;

export interface SchoolTargetClock {
  nowMs(): number;
}

export interface CreateSchoolTargetCommand {
  readonly intakeYear: number;
  readonly admissionType: string;
  readonly expectedResolutionSha256: string;
  readonly requestId: string;
  readonly idempotencyKey: string;
}

export interface SchoolTargetResult {
  readonly targetId: string;
  readonly caseId: string;
  readonly schoolId: string;
  readonly state: "candidate";
  readonly recordVersion: 1;
  readonly pin: ResolvedSchoolPin;
}

export interface SchoolTargetRepository {
  /**
   * Authorizes the caller's case visibility before returning snapshot and
   * overlay inputs. The create method must repeat this read under its write
   * transaction before committing a target pin.
   */
  readSchoolTargetResolution(input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly caseId: string;
    readonly schoolId: string;
  }): Promise<SchoolResolutionSource>;

  /**
   * Production must authorize current primary ownership, compare the current
   * resolved hash, enforce target uniqueness and then atomically persist the
   * immutable target pin, idempotency result, audit, and outbox rows.
   */
  createSchoolTarget(input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly caseId: string;
    readonly targetId: string;
    readonly schoolId: string;
    readonly intakeYear: number;
    readonly admissionType: string;
    readonly pin: ResolvedSchoolPin;
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
  | "SCHOOL_TARGET_ADVISOR_REQUIRED"
  | "SCHOOL_TARGET_CASE_NOT_FOUND"
  | "SCHOOL_TARGET_CASE_FORBIDDEN"
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

/** CaseWorkflow owns target facts; SchoolIntelligence only owns the resolved input. */
export class SchoolTargetService {
  private readonly repository: SchoolTargetRepository;
  private readonly clock: SchoolTargetClock;
  private readonly createId: () => string;

  constructor(options: SchoolTargetServiceOptions) {
    this.repository = options.repository;
    this.clock = options.clock ?? { nowMs: () => Date.now() };
    this.createId = options.createId ?? randomUUID;
  }

  async createSchoolTarget(input: {
    readonly actor: IdentitySessionActor;
    readonly caseId: string;
    readonly schoolId: string;
    readonly command: CreateSchoolTargetCommand;
  }): Promise<SchoolTargetResult> {
    assertAdvisor(input.actor);
    if (!UUID.test(input.caseId) || !UUID.test(input.schoolId)) {
      throw new SchoolTargetError("SCHOOL_TARGET_INVALID");
    }
    assertCommand(input.command);
    const creation = evaluateSchoolTargetCreation({ initialState: "candidate" });
    if (!creation.allowed) throw new SchoolTargetError("SCHOOL_TARGET_INVALID");

    const source = await this.repository.readSchoolTargetResolution({
      organizationId: input.actor.organizationId,
      actorUserId: input.actor.userId,
      caseId: input.caseId,
      schoolId: input.schoolId,
    });
    let resolved: ResolvedSchoolTargetView;
    try {
      resolved = resolveSchoolTargetView(source);
    } catch (error) {
      if (error instanceof SchoolResolutionError) {
        throw new SchoolTargetError("SCHOOL_TARGET_RESOLUTION_INVALID");
      }
      throw error;
    }
    let pin: ResolvedSchoolPin = resolved.pin;
    if (pin.resolutionSha256 !== input.command.expectedResolutionSha256) {
      throw new SchoolTargetError("SCHOOL_TARGET_RESOLUTION_STALE");
    }

    const targetId = this.createId();
    const resolvedRevisionId = this.createId();
    const auditId = this.createId();
    const outboxId = this.createId();
    for (const id of [targetId, resolvedRevisionId, auditId, outboxId]) assertUuid(id);
    pin = persistResolvedSchoolPin(resolved, resolvedRevisionId).pin;
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
      afterHashSha256: pin.resolutionSha256,
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
      caseId: input.caseId,
      targetId,
      schoolId: input.schoolId,
      intakeYear: input.command.intakeYear,
      admissionType: input.command.admissionType,
      pin,
      expectedResolutionSha256: input.command.expectedResolutionSha256,
      requestId: input.command.requestId,
      idempotencyKey: input.command.idempotencyKey,
      requestHash: hashRequestPayload({
        admissionType: input.command.admissionType,
        caseId: input.caseId,
        expectedResolutionSha256: input.command.expectedResolutionSha256,
        intakeYear: input.command.intakeYear,
        schoolId: input.schoolId,
      }),
      createdAtMs,
      effects: buildAtomicMutationEffects({ audit, outbox }),
    });
  }
}

function assertAdvisor(actor: IdentitySessionActor): void {
  if (!UUID.test(actor.organizationId) || !UUID.test(actor.userId) || actor.role !== "advisor") {
    throw new SchoolTargetError("SCHOOL_TARGET_ADVISOR_REQUIRED");
  }
}

function assertCommand(command: CreateSchoolTargetCommand): void {
  if (
    !Number.isSafeInteger(command.intakeYear) ||
    command.intakeYear < 1 ||
    !SAFE_CODE.test(command.admissionType) ||
    !SHA256.test(command.expectedResolutionSha256) ||
    !REQUEST_ID.test(command.requestId)
  ) {
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
