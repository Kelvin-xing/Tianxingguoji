import { randomUUID } from "node:crypto";

import {
  buildAtomicMutationEffects,
  buildAuditEvent,
  buildOutboxMessage,
  hashRedactedSnapshot,
  type MutationEffectBundle,
} from "../../audit/public.ts";
import type { IdentitySessionActor } from "../../identity/public.ts";
import { hashRequestPayload, validateIdempotencyKey } from "../../shared/public.ts";
import type { ServiceCaseStage } from "../domain/contract.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_REASON_LENGTH = 4_000;

export interface CaseTransitionClock {
  nowMs(): number;
}

export interface TransitionServiceCaseCommand {
  readonly toStage: ServiceCaseStage;
  readonly expectedRecordVersion: number;
  readonly reason: string;
  readonly requestId: string;
  readonly idempotencyKey: string;
}

export interface CaseTransitionResult {
  readonly caseId: string;
  readonly stage: ServiceCaseStage;
  readonly recordVersion: number;
}

export interface CaseTransitionRepositoryInput {
  readonly organizationId: string;
  readonly actor: IdentitySessionActor;
  readonly caseId: string;
  readonly fromStage: "signed" | "background_collection";
  readonly toStage: "signed" | "background_collection";
  readonly expectedRecordVersion: number;
  readonly reason: string | null;
  readonly transitionFactId: string;
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly transitionedAtMs: number;
  readonly effects: MutationEffectBundle;
}

export interface CaseTransitionRepository {
  /**
   * In one RDS transaction, the production adapter must lock the case,
   * current Primary Advisor relation, active actor role, approved manifest,
   * complete assessment blocker evidence, record version, and idempotency row.
   * It must then append the transition fact, update the case stage/version,
   * and insert the audit/outbox/idempotency facts or write nothing.
   */
  transitionServiceCase(input: CaseTransitionRepositoryInput): Promise<CaseTransitionResult>;
}

export type CaseTransitionErrorCode =
  | "CASE_TRANSITION_INVALID"
  | "CASE_TRANSITION_NOT_ALLOWED"
  | "CASE_TRANSITION_ADVISOR_REQUIRED"
  | "CASE_TRANSITION_PRIMARY_ADVISOR_REQUIRED"
  | "CASE_TRANSITION_FOUNDER_REQUIRED"
  | "CASE_TRANSITION_REASON_REQUIRED"
  | "CASE_TRANSITION_ASSESSMENT_INCOMPLETE"
  | "CASE_TRANSITION_CASE_NOT_FOUND"
  | "CASE_TRANSITION_CASE_FORBIDDEN"
  | "CASE_TRANSITION_STALE_VERSION"
  | "CASE_TRANSITION_IDEMPOTENCY_KEY_REUSED"
  | "CASE_TRANSITION_IDEMPOTENCY_IN_PROGRESS";

export class CaseTransitionError extends Error {
  readonly code: CaseTransitionErrorCode;
  readonly currentRecordVersion: number | null;

  constructor(
    code: CaseTransitionErrorCode,
    options: { readonly currentRecordVersion?: number } = {},
  ) {
    super(`Case transition rejected ${code}.`);
    this.name = "CaseTransitionError";
    this.code = code;
    this.currentRecordVersion = options.currentRecordVersion ?? null;
  }
}

export interface CaseTransitionServiceOptions {
  readonly repository: CaseTransitionRepository;
  readonly clock?: CaseTransitionClock;
  readonly createId?: () => string;
}

/**
 * Narrow P1-14 case-stage command. Identity establishes the fresh session
 * boundary first; the repository owns every mutable authorization read.
 */
export class CaseTransitionService {
  private readonly repository: CaseTransitionRepository;
  private readonly clock: CaseTransitionClock;
  private readonly createId: () => string;

  constructor(options: CaseTransitionServiceOptions) {
    this.repository = options.repository;
    this.clock = options.clock ?? { nowMs: () => Date.now() };
    this.createId = options.createId ?? randomUUID;
  }

  async transitionServiceCase(input: {
    readonly actor: IdentitySessionActor;
    readonly caseId: string;
    readonly command: TransitionServiceCaseCommand;
  }): Promise<CaseTransitionResult> {
    assertActorAndCase(input.actor, input.caseId);
    const direction = assertCommand(input.actor, input.command);
    const transitionedAtMs = this.clock.nowMs();
    if (!Number.isSafeInteger(transitionedAtMs) || transitionedAtMs <= 0) {
      throw new CaseTransitionError("CASE_TRANSITION_INVALID");
    }

    const transitionFactId = this.createId();
    const auditId = this.createId();
    const outboxId = this.createId();
    for (const id of [transitionFactId, auditId, outboxId]) assertUuid(id);

    const reason = input.command.reason.trim() || null;
    const occurredAt = new Date(transitionedAtMs).toISOString();
    const nextRecordVersion = input.command.expectedRecordVersion + 1;
    const eventType = "cases.service_case_stage_transitioned";
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
        status: direction.fromStage,
      }),
      afterHashSha256: hashRedactedSnapshot({
        record_version: nextRecordVersion,
        status: direction.toStage,
      }),
      metadata: {
        previous_version: input.command.expectedRecordVersion,
        next_version: nextRecordVersion,
        status: direction.toStage,
        reason_code: reason === null ? "not_required" : "provided",
        effect_type: "service_case_stage_transitioned",
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
      idempotencyKey: `case-transition-${outboxId}`,
      requestId: input.command.requestId,
      payload: {
        aggregate_id: input.caseId,
        record_version: nextRecordVersion,
        request_id: input.command.requestId,
        effect_type: "service_case_stage_transitioned",
        operation: "cases.transition",
        status: direction.toStage,
        reason_code: reason === null ? "not_required" : "provided",
      },
      availableAt: occurredAt,
      createdAt: occurredAt,
    });

    return this.repository.transitionServiceCase({
      organizationId: input.actor.organizationId,
      actor: input.actor,
      caseId: input.caseId,
      fromStage: direction.fromStage,
      toStage: direction.toStage,
      expectedRecordVersion: input.command.expectedRecordVersion,
      reason,
      transitionFactId,
      requestId: input.command.requestId,
      idempotencyKey: input.command.idempotencyKey,
      requestHash: hashRequestPayload({
        case_id: input.caseId,
        expected_record_version: input.command.expectedRecordVersion,
        reason,
        to_stage: direction.toStage,
      }),
      transitionedAtMs,
      effects: buildAtomicMutationEffects({ audit, outbox }),
    });
  }
}

function assertActorAndCase(actor: IdentitySessionActor, caseId: string): void {
  if (!UUID.test(actor.organizationId) || !UUID.test(actor.userId) || !UUID.test(caseId)) {
    throw new CaseTransitionError("CASE_TRANSITION_INVALID");
  }
}

function assertCommand(
  actor: IdentitySessionActor,
  command: TransitionServiceCaseCommand,
): { readonly fromStage: "signed" | "background_collection"; readonly toStage: "signed" | "background_collection" } {
  if (
    !Number.isSafeInteger(command.expectedRecordVersion) ||
    command.expectedRecordVersion < 1 ||
    typeof command.reason !== "string" ||
    command.reason.length > MAX_REASON_LENGTH ||
    !REQUEST_ID.test(command.requestId)
  ) {
    throw new CaseTransitionError("CASE_TRANSITION_INVALID");
  }
  try {
    validateIdempotencyKey(command.idempotencyKey);
  } catch {
    throw new CaseTransitionError("CASE_TRANSITION_INVALID");
  }

  if (command.toStage === "background_collection") {
    if (actor.role !== "advisor" && actor.role !== "founder") {
      throw new CaseTransitionError("CASE_TRANSITION_ADVISOR_REQUIRED");
    }
    return { fromStage: "signed", toStage: "background_collection" };
  }
  if (command.toStage === "signed") {
    if (actor.role !== "founder") {
      throw new CaseTransitionError("CASE_TRANSITION_FOUNDER_REQUIRED");
    }
    if (command.reason.trim() === "") {
      throw new CaseTransitionError("CASE_TRANSITION_REASON_REQUIRED");
    }
    return { fromStage: "background_collection", toStage: "signed" };
  }
  throw new CaseTransitionError("CASE_TRANSITION_NOT_ALLOWED");
}

function assertUuid(value: string): void {
  if (!UUID.test(value)) throw new CaseTransitionError("CASE_TRANSITION_INVALID");
}
