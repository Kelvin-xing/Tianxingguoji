import { randomUUID } from "node:crypto";

import { evaluateBootstrapAuthorization, type WorkspaceCapability } from "../../access/public.ts";
import {
  buildAtomicMutationEffects,
  buildAuditEvent,
  buildOutboxMessage,
  type MutationEffectBundle,
} from "../../audit/public.ts";
import type { IdentitySessionActor } from "../../identity/public.ts";
import { hashRequestPayload, validateIdempotencyKey } from "../../shared/public.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_CODE = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type CaseWorkspaceStage =
  | "signed"
  | "background_collection"
  | "school_selection_confirmed"
  | "interview_preparation"
  | "application_submitted"
  | "awaiting_result"
  | "offer_confirmed"
  | "closed";

export interface CaseWorkspaceListItem {
  readonly id: string;
  readonly caseNumber: string;
  readonly studentId: string;
  readonly studentName: string;
  readonly intakeYear: number;
  readonly admissionType: string;
  readonly stage: CaseWorkspaceStage;
  readonly updatedAt: string;
  readonly primaryRole: "founder" | "advisor";
}

export interface CaseWorkspaceDetail extends CaseWorkspaceListItem {
  readonly assessmentId: string;
  readonly assessmentStatus: "draft" | "background_complete" | "selection_ready";
  readonly manifestId: string;
  readonly primaryBindingLabel: string;
  readonly primaryUserId: string;
  readonly recordVersion: number;
}

export interface CaseWorkspaceOptions {
  readonly students: readonly Readonly<{ id: string; displayName: string }>[];
  readonly primaryBindings: readonly Readonly<{
    id: string;
    role: "founder" | "advisor";
    label: string;
  }>[];
  readonly manifests: readonly Readonly<{
    id: string;
    compositionVersion: string;
    label: string;
  }>[];
}

export interface CreatedExistingStudentCase {
  readonly id: string;
  readonly caseNumber: string;
  readonly studentId: string;
  readonly assessmentId: string;
  readonly intakeYear: number;
  readonly admissionType: string;
  readonly stage: "signed";
  readonly manifestId: string;
  readonly recordVersion: 1;
}

export interface CaseWorkspaceRepository {
  listCases(input: RepositoryActor): Promise<readonly CaseWorkspaceListItem[]>;
  findCase(input: RepositoryActor & { readonly caseId: string }): Promise<CaseWorkspaceDetail | null>;
  listOptions(input: RepositoryActor): Promise<CaseWorkspaceOptions>;
  createCase(input: RepositoryActor & {
    readonly actorRole: IdentitySessionActor["role"];
    readonly studentId: string;
    readonly serviceCaseId: string;
    readonly assessmentId: string;
    readonly caseNumber: string;
    readonly intakeYear: number;
    readonly admissionType: string;
    readonly primaryRoleBindingId: string;
    readonly manifestId: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly createdAtMs: number;
    readonly effects: MutationEffectBundle;
  }): Promise<CreatedExistingStudentCase>;
}

interface RepositoryActor {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly actorRole: IdentitySessionActor["role"];
}

export type CaseWorkspaceErrorCode =
  | "CASE_WORKSPACE_FORBIDDEN"
  | "CASE_WORKSPACE_INVALID"
  | "CASE_WORKSPACE_STUDENT_NOT_FOUND"
  | "CASE_WORKSPACE_BINDING_INACTIVE"
  | "CASE_WORKSPACE_MANIFEST_NOT_APPROVED"
  | "CASE_WORKSPACE_DUPLICATE"
  | "CASE_WORKSPACE_IDEMPOTENCY_CONFLICT"
  | "CASE_WORKSPACE_IDEMPOTENCY_IN_PROGRESS";

export class CaseWorkspaceError extends Error {
  readonly code: CaseWorkspaceErrorCode;

  constructor(code: CaseWorkspaceErrorCode) {
    super(`Case workspace rejected ${code}.`);
    this.name = "CaseWorkspaceError";
    this.code = code;
  }
}

const CASE_WORKSPACE_ERROR_CODES = new Set<CaseWorkspaceErrorCode>([
  "CASE_WORKSPACE_FORBIDDEN",
  "CASE_WORKSPACE_INVALID",
  "CASE_WORKSPACE_STUDENT_NOT_FOUND",
  "CASE_WORKSPACE_BINDING_INACTIVE",
  "CASE_WORKSPACE_MANIFEST_NOT_APPROVED",
  "CASE_WORKSPACE_DUPLICATE",
  "CASE_WORKSPACE_IDEMPOTENCY_CONFLICT",
  "CASE_WORKSPACE_IDEMPOTENCY_IN_PROGRESS",
]);

export function isCaseWorkspaceError(
  error: unknown,
  code?: CaseWorkspaceErrorCode,
): error is CaseWorkspaceError {
  if (!(error instanceof Error) || error.name !== "CaseWorkspaceError") return false;
  const candidate = (error as Error & { readonly code?: unknown }).code;
  if (
    typeof candidate !== "string" ||
    !CASE_WORKSPACE_ERROR_CODES.has(candidate as CaseWorkspaceErrorCode)
  ) {
    return false;
  }
  return code === undefined || candidate === code;
}

export class CaseWorkspaceRepositoryError extends Error {
  readonly code: CaseWorkspaceErrorCode;

  constructor(code: CaseWorkspaceErrorCode) {
    super(`Case workspace repository rejected ${code}.`);
    this.name = "CaseWorkspaceRepositoryError";
    this.code = code;
  }
}

export function isCaseWorkspaceRepositoryError(
  error: unknown,
): error is CaseWorkspaceRepositoryError {
  if (!(error instanceof Error) || error.name !== "CaseWorkspaceRepositoryError") return false;
  const candidate = (error as Error & { readonly code?: unknown }).code;
  return typeof candidate === "string" &&
    CASE_WORKSPACE_ERROR_CODES.has(candidate as CaseWorkspaceErrorCode);
}

export class CaseWorkspaceService {
  private readonly repository: CaseWorkspaceRepository;
  private readonly createId: () => string;
  private readonly nowMs: () => number;

  constructor(
    repository: CaseWorkspaceRepository,
    createId: () => string = randomUUID,
    nowMs: () => number = Date.now,
  ) {
    this.repository = repository;
    this.createId = createId;
    this.nowMs = nowMs;
  }

  listCases(actor: IdentitySessionActor) {
    return this.repository.listCases(repositoryActor(actor, "cases.read"));
  }

  findCase(actor: IdentitySessionActor, caseId: string) {
    const context = repositoryActor(actor, "cases.read");
    if (!UUID.test(caseId)) throw new CaseWorkspaceError("CASE_WORKSPACE_INVALID");
    return this.repository.findCase({ ...context, caseId });
  }

  listOptions(actor: IdentitySessionActor) {
    return this.repository.listOptions(repositoryActor(actor, "cases.create"));
  }

  async createCase(input: {
    readonly actor: IdentitySessionActor;
    readonly command: Readonly<{
      studentId: string;
      intakeYear: number;
      admissionType: string;
      primaryRoleBindingId: string;
      manifestId: string;
      requestId: string;
      idempotencyKey: string;
    }>;
  }): Promise<CreatedExistingStudentCase> {
    const actor = repositoryActor(input.actor, "cases.create");
    assertCommand(input.command);
    const serviceCaseId = this.createId();
    const assessmentId = this.createId();
    const auditId = this.createId();
    const outboxId = this.createId();
    for (const id of [serviceCaseId, assessmentId, auditId, outboxId]) {
      if (!UUID.test(id)) throw new CaseWorkspaceError("CASE_WORKSPACE_INVALID");
    }
    const createdAtMs = this.nowMs();
    if (!Number.isFinite(createdAtMs) || createdAtMs <= 0) {
      throw new CaseWorkspaceError("CASE_WORKSPACE_INVALID");
    }
    const occurredAt = new Date(createdAtMs).toISOString();
    const caseNumber = `TX-${input.command.intakeYear}-${serviceCaseId.slice(0, 8).toUpperCase()}`;
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
      metadata: { record_version: 1, status: "signed", effect_type: "case.created" },
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
        request_id: input.command.requestId,
        effect_type: "case.created",
        record_version: 1,
        status: "signed",
      },
      availableAt: occurredAt,
      createdAt: occurredAt,
    });

    try {
      return await this.repository.createCase({
        ...actor,
        studentId: input.command.studentId,
        serviceCaseId,
        assessmentId,
        caseNumber,
        intakeYear: input.command.intakeYear,
        admissionType: input.command.admissionType,
        primaryRoleBindingId: input.command.primaryRoleBindingId,
        manifestId: input.command.manifestId,
        idempotencyKey: input.command.idempotencyKey,
        requestHash: hashRequestPayload({
          admissionType: input.command.admissionType,
          intakeYear: input.command.intakeYear,
          manifestId: input.command.manifestId,
          primaryRoleBindingId: input.command.primaryRoleBindingId,
          studentId: input.command.studentId,
        }),
        createdAtMs,
        effects: buildAtomicMutationEffects({ audit, outbox }),
      });
    } catch (error) {
      if (isCaseWorkspaceRepositoryError(error)) {
        throw new CaseWorkspaceError(error.code);
      }
      throw error;
    }
  }
}

function repositoryActor(
  actor: IdentitySessionActor,
  capability: WorkspaceCapability,
): RepositoryActor {
  const decision = evaluateBootstrapAuthorization(actor.role, { capability });
  if (!UUID.test(actor.organizationId) || !UUID.test(actor.userId) || !decision.allowed) {
    throw new CaseWorkspaceError("CASE_WORKSPACE_FORBIDDEN");
  }
  return {
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    actorRole: actor.role,
  };
}

function assertCommand(command: {
  readonly studentId: string;
  readonly intakeYear: number;
  readonly admissionType: string;
  readonly primaryRoleBindingId: string;
  readonly manifestId: string;
  readonly requestId: string;
  readonly idempotencyKey: string;
}): void {
  if (
    !UUID.test(command.studentId) ||
    !UUID.test(command.primaryRoleBindingId) ||
    !UUID.test(command.manifestId) ||
    !Number.isSafeInteger(command.intakeYear) ||
    command.intakeYear < 2000 ||
    command.intakeYear > 2200 ||
    !SAFE_CODE.test(command.admissionType) ||
    !REQUEST_ID.test(command.requestId)
  ) {
    throw new CaseWorkspaceError("CASE_WORKSPACE_INVALID");
  }
  try {
    validateIdempotencyKey(command.idempotencyKey);
  } catch {
    throw new CaseWorkspaceError("CASE_WORKSPACE_INVALID");
  }
}
