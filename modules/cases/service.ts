import { randomUUID } from "node:crypto";

import {
  buildAtomicMutationEffects,
  buildAuditEvent,
  buildOutboxMessage,
  type MutationEffectBundle,
} from "../audit/contract.ts";
import { CrmService, CrmServiceError, type PreparedStudent, type StudentDraft } from "../crm/service.ts";
import type { IdentitySessionActor } from "../identity/session-repository.ts";
import { hashRequestPayload, validateIdempotencyKey } from "../shared/idempotency.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_CODE = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;

export interface CaseCreationClock {
  nowMs(): number;
}

export interface CreateK12CaseCommand {
  readonly student: StudentDraft;
  readonly intakeYear: number;
  readonly admissionType: string;
  readonly caseNumber: string;
  readonly schemaManifestId: string;
  readonly requestId: string;
  readonly idempotencyKey: string;
}

export interface CaseCreationResult {
  readonly studentId: string;
  readonly serviceCaseId: string;
  readonly assessmentId: string;
  readonly primaryAdvisorUserId: string;
  readonly stage: "signed";
  readonly recordVersion: 1;
}

export interface CaseCreationRepository {
  /**
   * Must use one database transaction for the idempotency record, Student,
   * ServiceCase, Assessment, audit event, and outbox row. The implementation
   * resolves the Advisor binding and approved manifest inside that transaction.
   */
  createStudentAndK12Case(input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly student: PreparedStudent;
    readonly serviceCaseId: string;
    readonly assessmentId: string;
    readonly intakeYear: number;
    readonly admissionType: string;
    readonly caseNumber: string;
    readonly schemaManifestId: string;
    readonly requestId: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly createdAtMs: number;
    readonly effects: MutationEffectBundle;
  }): Promise<CaseCreationResult>;
}

export type CaseCreationErrorCode =
  | "CASE_CREATION_INVALID"
  | "CASE_ADVISOR_REQUIRED"
  | "CASE_CREATION_IDEMPOTENCY_KEY_REUSED"
  | "CASE_CREATION_IDEMPOTENCY_IN_PROGRESS"
  | "CASE_CREATION_ACTIVE_DUPLICATE"
  | "CASE_CREATION_MANIFEST_NOT_APPROVED"
  | "CASE_CREATION_PRIMARY_BINDING_INACTIVE";

export class CaseCreationError extends Error {
  readonly code: CaseCreationErrorCode;

  constructor(code: CaseCreationErrorCode) {
    super(`Case creation rejected ${code}.`);
    this.name = "CaseCreationError";
    this.code = code;
  }
}

export interface CaseServiceOptions {
  readonly repository: CaseCreationRepository;
  readonly crm?: CrmService;
  readonly clock?: CaseCreationClock;
  readonly createId?: () => string;
}

/**
 * CaseWorkflow command seam for F03. The caller supplies student facts and
 * immutable case inputs; the repository makes all authorization-sensitive
 * reads and writes in its single transaction.
 */
export class CaseService {
  private readonly repository: CaseCreationRepository;
  private readonly crm: CrmService;
  private readonly clock: CaseCreationClock;
  private readonly createId: () => string;

  constructor(options: CaseServiceOptions) {
    this.repository = options.repository;
    this.crm = options.crm ?? new CrmService();
    this.clock = options.clock ?? { nowMs: () => Date.now() };
    this.createId = options.createId ?? randomUUID;
  }

  async createAdvisorK12Case(input: {
    readonly actor: IdentitySessionActor;
    readonly command: CreateK12CaseCommand;
  }): Promise<CaseCreationResult> {
    assertActor(input.actor);
    assertCommand(input.command);

    const studentId = this.createId();
    const serviceCaseId = this.createId();
    const assessmentId = this.createId();
    const auditId = this.createId();
    const outboxId = this.createId();
    for (const id of [studentId, serviceCaseId, assessmentId, auditId, outboxId]) assertUuid(id);

    let student: PreparedStudent;
    try {
      student = this.crm.prepareActiveStudent({ studentId, draft: input.command.student });
    } catch (error) {
      if (error instanceof CrmServiceError) throw new CaseCreationError("CASE_CREATION_INVALID");
      throw error;
    }

    const createdAtMs = this.clock.nowMs();
    if (!Number.isFinite(createdAtMs) || createdAtMs <= 0) {
      throw new CaseCreationError("CASE_CREATION_INVALID");
    }
    const occurredAt = new Date(createdAtMs).toISOString();
    const audit = buildAuditEvent({
      id: auditId,
      organizationId: input.actor.organizationId,
      actorUserId: input.actor.userId,
      actorKind: "user",
      eventType: "cases.service_case_created",
      eventVersion: 1,
      action: "create",
      resourceType: "ServiceCase",
      resourceId: serviceCaseId,
      outcome: "succeeded",
      requestId: input.command.requestId,
      occurredAt,
      metadata: {
        record_version: 1,
        status: "signed",
        effect_type: "case.created",
      },
    });
    const outbox = buildOutboxMessage({
      id: outboxId,
      auditEventId: auditId,
      organizationId: input.actor.organizationId,
      aggregateType: "ServiceCase",
      aggregateId: serviceCaseId,
      eventType: "cases.service_case_created",
      eventVersion: 1,
      idempotencyKey: `case-create-${outboxId}`,
      requestId: input.command.requestId,
      payload: {
        aggregate_id: serviceCaseId,
        effect_type: "case.created",
        record_version: 1,
        request_id: input.command.requestId,
        status: "signed",
      },
      availableAt: occurredAt,
      createdAt: occurredAt,
    });

    return this.repository.createStudentAndK12Case({
      organizationId: input.actor.organizationId,
      actorUserId: input.actor.userId,
      student,
      serviceCaseId,
      assessmentId,
      intakeYear: input.command.intakeYear,
      admissionType: input.command.admissionType,
      caseNumber: input.command.caseNumber,
      schemaManifestId: input.command.schemaManifestId,
      requestId: input.command.requestId,
      idempotencyKey: input.command.idempotencyKey,
      requestHash: hashRequestPayload({
        admissionType: input.command.admissionType,
        caseNumber: input.command.caseNumber,
        intakeYear: input.command.intakeYear,
        schemaManifestId: input.command.schemaManifestId,
        student: input.command.student,
      }),
      createdAtMs,
      effects: buildAtomicMutationEffects({ audit, outbox }),
    });
  }
}

function assertActor(actor: IdentitySessionActor): void {
  if (!UUID.test(actor.organizationId) || !UUID.test(actor.userId) || actor.role !== "advisor") {
    throw new CaseCreationError("CASE_ADVISOR_REQUIRED");
  }
}

function assertCommand(command: CreateK12CaseCommand): void {
  if (
    !Number.isSafeInteger(command.intakeYear) ||
    command.intakeYear < 1 ||
    !SAFE_CODE.test(command.admissionType) ||
    !SAFE_CODE.test(command.caseNumber) ||
    !SAFE_CODE.test(command.requestId) ||
    !UUID.test(command.schemaManifestId)
  ) {
    throw new CaseCreationError("CASE_CREATION_INVALID");
  }
  try {
    validateIdempotencyKey(command.idempotencyKey);
  } catch {
    throw new CaseCreationError("CASE_CREATION_INVALID");
  }
}

function assertUuid(value: string): void {
  if (!UUID.test(value)) throw new CaseCreationError("CASE_CREATION_INVALID");
}
