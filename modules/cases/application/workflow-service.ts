import { randomUUID } from "node:crypto";

import { evaluateBootstrapAuthorization } from "../../access/public.ts";
import {
  buildAtomicMutationEffects,
  buildAuditEvent,
  buildOutboxMessage,
  hashRedactedSnapshot,
  type MutationEffectBundle,
} from "../../audit/public.ts";
import type { IdentitySessionActor } from "../../identity/public.ts";
import { hashRequestPayload, validateIdempotencyKey } from "../../shared/public.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type CaseWorkflowAction = "pause" | "resume";
export type CaseWorkflowStatus = "active" | "paused" | "termination_pending" | "closed";

export interface ApplyCaseWorkflowActionCommand {
  readonly action: CaseWorkflowAction;
  readonly expectedRecordVersion: number;
  readonly reason: string | null;
  readonly requestId: string;
  readonly idempotencyKey: string;
}

export interface CaseWorkflowAcknowledgement {
  readonly id: string;
  readonly recordVersion: number;
}

export interface CaseWorkflowRepositoryInput {
  readonly organizationId: string;
  readonly actor: IdentitySessionActor;
  readonly caseId: string;
  readonly action: CaseWorkflowAction;
  readonly expectedRecordVersion: number;
  readonly reason: string | null;
  readonly lifecycleFactId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly occurredAtMs: number;
  readonly effects: MutationEffectBundle;
}

export interface CaseWorkflowRepository {
  applyWorkflowAction(input: CaseWorkflowRepositoryInput): Promise<CaseWorkflowAcknowledgement>;
}

export type CaseWorkflowErrorCode =
  | "CASE_WORKFLOW_INVALID"
  | "CASE_WORKFLOW_FORBIDDEN"
  | "CASE_WORKFLOW_CASE_NOT_FOUND"
  | "CASE_WORKFLOW_STALE_VERSION"
  | "CASE_WORKFLOW_CONFLICT"
  | "CASE_WORKFLOW_SUBMITTED_TARGET_EXISTS"
  | "CASE_WORKFLOW_IDEMPOTENCY_KEY_REUSED"
  | "CASE_WORKFLOW_IDEMPOTENCY_IN_PROGRESS";

export class CaseWorkflowError extends Error {
  readonly code: CaseWorkflowErrorCode;
  readonly currentRecordVersion: number | null;

  constructor(
    code: CaseWorkflowErrorCode,
    options: { readonly currentRecordVersion?: number } = {},
  ) {
    super(`Case workflow command rejected ${code}.`);
    this.name = "CaseWorkflowError";
    this.code = code;
    this.currentRecordVersion = options.currentRecordVersion ?? null;
  }
}

const CASE_WORKFLOW_ERROR_CODES = new Set<CaseWorkflowErrorCode>([
  "CASE_WORKFLOW_INVALID",
  "CASE_WORKFLOW_FORBIDDEN",
  "CASE_WORKFLOW_CASE_NOT_FOUND",
  "CASE_WORKFLOW_STALE_VERSION",
  "CASE_WORKFLOW_CONFLICT",
  "CASE_WORKFLOW_SUBMITTED_TARGET_EXISTS",
  "CASE_WORKFLOW_IDEMPOTENCY_KEY_REUSED",
  "CASE_WORKFLOW_IDEMPOTENCY_IN_PROGRESS",
]);

export function isCaseWorkflowError(error: unknown): error is CaseWorkflowError {
  if (!(error instanceof Error) || error.name !== "CaseWorkflowError") return false;
  const code = (error as Error & { readonly code?: unknown }).code;
  return typeof code === "string" && CASE_WORKFLOW_ERROR_CODES.has(code as CaseWorkflowErrorCode);
}

export class CaseWorkflowService {
  private readonly repository: CaseWorkflowRepository;
  private readonly createId: () => string;
  private readonly nowMs: () => number;

  constructor(
    repository: CaseWorkflowRepository,
    createId: () => string = randomUUID,
    nowMs: () => number = Date.now,
  ) {
    this.repository = repository;
    this.createId = createId;
    this.nowMs = nowMs;
  }

  async applyWorkflowAction(input: {
    readonly actor: IdentitySessionActor;
    readonly caseId: string;
    readonly command: ApplyCaseWorkflowActionCommand;
  }): Promise<CaseWorkflowAcknowledgement> {
    assertInput(input);
    const authorization = evaluateBootstrapAuthorization(input.actor.role, {
      capability: "cases.workflow.manage",
    });
    if (!authorization.allowed) throw new CaseWorkflowError("CASE_WORKFLOW_FORBIDDEN");

    const lifecycleFactId = this.createId();
    const auditId = this.createId();
    const outboxId = this.createId();
    for (const id of [lifecycleFactId, auditId, outboxId]) {
      if (!UUID.test(id)) throw new CaseWorkflowError("CASE_WORKFLOW_INVALID");
    }
    const occurredAtMs = this.nowMs();
    if (!Number.isSafeInteger(occurredAtMs) || occurredAtMs <= 0) {
      throw new CaseWorkflowError("CASE_WORKFLOW_INVALID");
    }
    const occurredAt = new Date(occurredAtMs).toISOString();
    const nextRecordVersion = input.command.expectedRecordVersion + 1;
    const nextStatus = input.command.action === "pause" ? "paused" : "active";
    const eventType = `cases.service_case_${input.command.action}d`;
    const audit = buildAuditEvent({
      id: auditId,
      organizationId: input.actor.organizationId,
      actorUserId: input.actor.userId,
      actorKind: "user",
      eventType,
      eventVersion: 1,
      action: "transition",
      resourceType: "ServiceCase",
      resourceId: input.caseId,
      outcome: "succeeded",
      requestId: input.command.requestId,
      occurredAt,
      beforeHashSha256: hashRedactedSnapshot({
        record_version: input.command.expectedRecordVersion,
        status: input.command.action === "pause" ? "active" : "paused",
      }),
      afterHashSha256: hashRedactedSnapshot({
        record_version: nextRecordVersion,
        status: nextStatus,
      }),
      metadata: {
        effect_type: `service_case_${input.command.action}d`,
        next_version: nextRecordVersion,
        previous_version: input.command.expectedRecordVersion,
        reason_code: input.command.reason === null ? "not_required" : "provided",
        status: nextStatus,
      },
    });
    const outbox = buildOutboxMessage({
      id: outboxId,
      auditEventId: auditId,
      organizationId: input.actor.organizationId,
      aggregateType: "ServiceCase",
      aggregateId: input.caseId,
      eventType,
      eventVersion: 1,
      idempotencyKey: `case-workflow-${outboxId}`,
      requestId: input.command.requestId,
      payload: {
        aggregate_id: input.caseId,
        effect_type: `service_case_${input.command.action}d`,
        operation: "cases.workflow_action",
        record_version: nextRecordVersion,
        request_id: input.command.requestId,
        status: nextStatus,
      },
      availableAt: occurredAt,
      createdAt: occurredAt,
    });

    return this.repository.applyWorkflowAction({
      organizationId: input.actor.organizationId,
      actor: input.actor,
      caseId: input.caseId,
      action: input.command.action,
      expectedRecordVersion: input.command.expectedRecordVersion,
      reason: input.command.reason === null ? null : input.command.reason.trim(),
      lifecycleFactId,
      idempotencyKey: input.command.idempotencyKey,
      requestHash: hashRequestPayload({
        action: input.command.action,
        case_id: input.caseId,
        expected_record_version: input.command.expectedRecordVersion,
        reason: input.command.reason === null ? null : input.command.reason.trim(),
      }),
      occurredAtMs,
      effects: buildAtomicMutationEffects({ audit, outbox }),
    });
  }
}

function assertInput(input: {
  readonly actor: IdentitySessionActor;
  readonly caseId: string;
  readonly command: ApplyCaseWorkflowActionCommand;
}): void {
  const { actor, caseId, command } = input;
  if (
    !UUID.test(actor.organizationId) ||
    !UUID.test(actor.userId) ||
    !UUID.test(caseId) ||
    (command.action !== "pause" && command.action !== "resume") ||
    !Number.isSafeInteger(command.expectedRecordVersion) ||
    command.expectedRecordVersion < 1 ||
    !REQUEST_ID.test(command.requestId)
  ) {
    throw new CaseWorkflowError("CASE_WORKFLOW_INVALID");
  }
  if (
    (command.action === "pause" &&
      (typeof command.reason !== "string" || command.reason.trim() === "" ||
        command.reason.trim().length > 1000)) ||
    (command.action === "resume" && command.reason !== null)
  ) {
    throw new CaseWorkflowError("CASE_WORKFLOW_INVALID");
  }
  try {
    validateIdempotencyKey(command.idempotencyKey);
  } catch {
    throw new CaseWorkflowError("CASE_WORKFLOW_INVALID");
  }
}
