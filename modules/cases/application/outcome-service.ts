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
import type { CaseOutcomeCode, SchoolTargetState } from "../domain/contract.ts";
import type { SchoolTargetEvidence } from "../domain/transition-policy.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_REFERENCE_LENGTH = 4_000;

export type CaseOutcomeSource = "official_portal" | "official_letter" | "advisor_attested";

export interface CaseOutcomeDraft {
  readonly code: CaseOutcomeCode;
  readonly occurredOn: string;
  readonly evidenceSource: CaseOutcomeSource;
  readonly sourceReference: string;
}

export interface SchoolTargetTransitionCommand {
  readonly toState: SchoolTargetState;
  readonly expectedRecordVersion: number;
  readonly evidence: SchoolTargetEvidence;
  readonly outcome: CaseOutcomeDraft | null;
  readonly requestId: string;
  readonly idempotencyKey: string;
}

export interface CorrectCaseOutcomeCommand {
  readonly expectedOutcomeRecordVersion: number;
  readonly outcome: CaseOutcomeDraft;
  readonly requestId: string;
  readonly idempotencyKey: string;
}

export interface CaseOutcomeRevisionResult {
  readonly outcomeRevisionId: string;
  readonly targetId: string;
  readonly code: CaseOutcomeCode;
  readonly recordVersion: number;
}

export interface SchoolTargetTransitionResult {
  readonly targetId: string;
  readonly caseId: string;
  readonly state: SchoolTargetState;
  readonly recordVersion: number;
  readonly outcome: CaseOutcomeRevisionResult | null;
}

export interface CaseOutcomeRepository {
  /**
   * The HK RDS implementation is the enforcement owner. In one transaction it
   * must lock the target, its Case, current Primary Advisor relation, actor
   * role/case visibility, route-template version, target/outcome versions, and
   * idempotency row. It then evaluates transition-policy.ts using current
   * state, writes target transition plus optional immutable outcome revision,
   * audit/outbox/idempotency facts, or writes nothing.
   */
  transitionSchoolTarget(input: {
    readonly organizationId: string;
    readonly actor: IdentitySessionActor;
    readonly caseId: string;
    readonly targetId: string;
    readonly command: SchoolTargetTransitionCommand;
    readonly transitionFactId: string;
    readonly outcomeRevisionId: string | null;
    readonly requestHash: string;
    readonly transitionedAtMs: number;
    readonly effects: MutationEffectBundle;
  }): Promise<SchoolTargetTransitionResult>;

  /**
   * Outcome corrections append a revision; they never mutate the previously
   * current CaseOutcome. The same transaction re-authorizes the actor and
   * re-validates the terminal target/code/evidence relationship.
   */
  correctCaseOutcome(input: {
    readonly organizationId: string;
    readonly actor: IdentitySessionActor;
    readonly caseId: string;
    readonly targetId: string;
    readonly command: CorrectCaseOutcomeCommand;
    readonly outcomeRevisionId: string;
    readonly requestHash: string;
    readonly correctedAtMs: number;
    readonly effects: MutationEffectBundle;
  }): Promise<CaseOutcomeRevisionResult>;
}

export type CaseOutcomeErrorCode =
  | "CASE_OUTCOME_INVALID"
  | "CASE_OUTCOME_ADVISOR_REQUIRED"
  | "CASE_OUTCOME_CASE_NOT_FOUND"
  | "CASE_OUTCOME_TARGET_NOT_FOUND"
  | "CASE_OUTCOME_CASE_FORBIDDEN"
  | "CASE_OUTCOME_ROUTE_POLICY_REQUIRED"
  | "CASE_OUTCOME_TRANSITION_NOT_ALLOWED"
  | "CASE_OUTCOME_EVIDENCE_REQUIRED"
  | "CASE_OUTCOME_REQUIRED"
  | "CASE_OUTCOME_CODE_INVALID"
  | "CASE_OUTCOME_STALE_VERSION"
  | "CASE_OUTCOME_IDEMPOTENCY_KEY_REUSED"
  | "CASE_OUTCOME_IDEMPOTENCY_IN_PROGRESS";

export class CaseOutcomeError extends Error {
  readonly code: CaseOutcomeErrorCode;
  readonly currentRecordVersion: number | null;

  constructor(
    code: CaseOutcomeErrorCode,
    options: { readonly currentRecordVersion?: number } = {},
  ) {
    super(`Case target or outcome command rejected ${code}.`);
    this.name = "CaseOutcomeError";
    this.code = code;
    this.currentRecordVersion = options.currentRecordVersion ?? null;
  }
}

export interface CaseOutcomeClock {
  nowMs(): number;
}

export interface CaseOutcomeServiceOptions {
  readonly repository: CaseOutcomeRepository;
  readonly clock?: CaseOutcomeClock;
  readonly createId?: () => string;
}

/**
 * This service frames commands and emits redacted effects. It deliberately
 * does not pre-read mutable Case/Target policy inputs: the transaction port
 * owns those reads so authorization and transition facts cannot drift apart.
 */
export class CaseOutcomeService {
  private readonly repository: CaseOutcomeRepository;
  private readonly clock: CaseOutcomeClock;
  private readonly createId: () => string;

  constructor(options: CaseOutcomeServiceOptions) {
    this.repository = options.repository;
    this.clock = options.clock ?? { nowMs: () => Date.now() };
    this.createId = options.createId ?? randomUUID;
  }

  async transitionSchoolTarget(input: {
    readonly actor: IdentitySessionActor;
    readonly caseId: string;
    readonly targetId: string;
    readonly command: SchoolTargetTransitionCommand;
  }): Promise<SchoolTargetTransitionResult> {
    assertAdvisorAndIds(input.actor, input.caseId, input.targetId);
    assertTargetTransitionCommand(input.command);
    const transitionedAtMs = assertNow(this.clock.nowMs());
    const transitionFactId = this.createId();
    const outcomeRevisionId = input.command.outcome === null ? null : this.createId();
    const auditId = this.createId();
    const outboxId = this.createId();
    for (const id of [transitionFactId, auditId, outboxId, outcomeRevisionId]) {
      if (id !== null) assertUuid(id);
    }
    const occurredAt = new Date(transitionedAtMs).toISOString();
    const eventType = input.command.outcome === null
      ? "cases.school_target_transitioned"
      : "cases.school_target_terminal_outcome_recorded";
    const nextRecordVersion = input.command.expectedRecordVersion + 1;
    const effects = buildAtomicMutationEffects({
      audit: buildAuditEvent({
        id: auditId,
        organizationId: input.actor.organizationId,
        actorUserId: input.actor.userId,
        actorKind: "user",
        eventType,
        eventVersion: 1,
        action: "transition",
        resourceType: "SchoolTarget",
        resourceId: input.targetId,
        outcome: "succeeded",
        requestId: input.command.requestId,
        occurredAt,
        afterHashSha256: hashRedactedSnapshot({
          record_version: nextRecordVersion,
          status: input.command.outcome?.code ?? input.command.toState,
        }),
        metadata: {
          effect_type: eventType,
          record_version: nextRecordVersion,
          status: input.command.outcome?.code ?? input.command.toState,
        },
      }),
      outbox: buildOutboxMessage({
        id: outboxId,
        auditEventId: auditId,
        organizationId: input.actor.organizationId,
        aggregateType: "SchoolTarget",
        aggregateId: input.targetId,
        eventType,
        eventVersion: 1,
        idempotencyKey: `case-outcome-${outboxId}`,
        requestId: input.command.requestId,
        payload: {
          aggregate_id: input.targetId,
          effect_type: eventType,
          operation: "cases.school_target.transition",
          record_version: nextRecordVersion,
          request_id: input.command.requestId,
          status: input.command.outcome?.code ?? input.command.toState,
        },
        availableAt: occurredAt,
        createdAt: occurredAt,
      }),
    });

    return this.repository.transitionSchoolTarget({
      organizationId: input.actor.organizationId,
      actor: input.actor,
      caseId: input.caseId,
      targetId: input.targetId,
      command: input.command,
      transitionFactId,
      outcomeRevisionId,
      requestHash: hashRequestPayload({
        case_id: input.caseId,
        target_id: input.targetId,
        expected_record_version: input.command.expectedRecordVersion,
        to_state: input.command.toState,
        evidence: serializeTargetEvidence(input.command.evidence),
        outcome: input.command.outcome === null ? null : serializeOutcome(input.command.outcome),
      }),
      transitionedAtMs,
      effects,
    });
  }

  async correctCaseOutcome(input: {
    readonly actor: IdentitySessionActor;
    readonly caseId: string;
    readonly targetId: string;
    readonly command: CorrectCaseOutcomeCommand;
  }): Promise<CaseOutcomeRevisionResult> {
    assertAdvisorAndIds(input.actor, input.caseId, input.targetId);
    assertCorrectOutcomeCommand(input.command);
    const correctedAtMs = assertNow(this.clock.nowMs());
    const outcomeRevisionId = this.createId();
    const auditId = this.createId();
    const outboxId = this.createId();
    for (const id of [outcomeRevisionId, auditId, outboxId]) assertUuid(id);
    const occurredAt = new Date(correctedAtMs).toISOString();
    const nextRecordVersion = input.command.expectedOutcomeRecordVersion + 1;
    const eventType = "cases.case_outcome_corrected";
    const effects = buildAtomicMutationEffects({
      audit: buildAuditEvent({
        id: auditId,
        organizationId: input.actor.organizationId,
        actorUserId: input.actor.userId,
        actorKind: "user",
        eventType,
        eventVersion: 1,
        action: "correct",
        resourceType: "CaseOutcome",
        resourceId: outcomeRevisionId,
        outcome: "succeeded",
        requestId: input.command.requestId,
        occurredAt,
        afterHashSha256: hashRedactedSnapshot({
          record_version: nextRecordVersion,
          status: input.command.outcome.code,
        }),
        metadata: {
          effect_type: eventType,
          record_version: nextRecordVersion,
          status: input.command.outcome.code,
        },
      }),
      outbox: buildOutboxMessage({
        id: outboxId,
        auditEventId: auditId,
        organizationId: input.actor.organizationId,
        aggregateType: "CaseOutcome",
        aggregateId: outcomeRevisionId,
        eventType,
        eventVersion: 1,
        idempotencyKey: `case-outcome-${outboxId}`,
        requestId: input.command.requestId,
        payload: {
          aggregate_id: outcomeRevisionId,
          effect_type: eventType,
          operation: "cases.case_outcome.correct",
          record_version: nextRecordVersion,
          request_id: input.command.requestId,
          status: input.command.outcome.code,
        },
        availableAt: occurredAt,
        createdAt: occurredAt,
      }),
    });

    return this.repository.correctCaseOutcome({
      organizationId: input.actor.organizationId,
      actor: input.actor,
      caseId: input.caseId,
      targetId: input.targetId,
      command: input.command,
      outcomeRevisionId,
      requestHash: hashRequestPayload({
        case_id: input.caseId,
        target_id: input.targetId,
        expected_outcome_record_version: input.command.expectedOutcomeRecordVersion,
        outcome: serializeOutcome(input.command.outcome),
      }),
      correctedAtMs,
      effects,
    });
  }
}

function serializeTargetEvidence(evidence: SchoolTargetEvidence) {
  return {
    dueDate: evidence.dueDate,
    checklistCompleteReceipt: evidence.checklistCompleteReceipt,
    officialSubmissionReference: evidence.officialSubmissionReference,
    invitationEvidence: evidence.invitationEvidence,
    interviewAt: evidence.interviewAt,
  };
}

function serializeOutcome(outcome: CaseOutcomeDraft) {
  return {
    code: outcome.code,
    occurredOn: outcome.occurredOn,
    evidenceSource: outcome.evidenceSource,
    sourceReference: outcome.sourceReference,
  };
}

function assertAdvisorAndIds(actor: IdentitySessionActor, caseId: string, targetId: string): void {
  if (
    actor.role !== "advisor" ||
    !UUID.test(actor.organizationId) ||
    !UUID.test(actor.userId) ||
    !UUID.test(caseId) ||
    !UUID.test(targetId)
  ) {
    throw new CaseOutcomeError("CASE_OUTCOME_ADVISOR_REQUIRED");
  }
}

function assertTargetTransitionCommand(command: SchoolTargetTransitionCommand): void {
  if (
    !Number.isSafeInteger(command.expectedRecordVersion) ||
    command.expectedRecordVersion < 1 ||
    !REQUEST_ID.test(command.requestId) ||
    !isSchoolTargetState(command.toState) ||
    !isEvidenceShape(command.evidence)
  ) {
    throw new CaseOutcomeError("CASE_OUTCOME_INVALID");
  }
  if (command.outcome !== null) assertOutcomeDraft(command.outcome);
  assertIdempotencyKey(command.idempotencyKey);
}

function assertCorrectOutcomeCommand(command: CorrectCaseOutcomeCommand): void {
  if (
    !Number.isSafeInteger(command.expectedOutcomeRecordVersion) ||
    command.expectedOutcomeRecordVersion < 1 ||
    !REQUEST_ID.test(command.requestId)
  ) {
    throw new CaseOutcomeError("CASE_OUTCOME_INVALID");
  }
  assertOutcomeDraft(command.outcome);
  assertIdempotencyKey(command.idempotencyKey);
}

function assertOutcomeDraft(outcome: CaseOutcomeDraft): void {
  if (
    !isCaseOutcomeCode(outcome.code) ||
    !isIsoCalendarDate(outcome.occurredOn) ||
    !isCaseOutcomeSource(outcome.evidenceSource) ||
    !isReference(outcome.sourceReference)
  ) {
    throw new CaseOutcomeError("CASE_OUTCOME_INVALID");
  }
}

function assertIdempotencyKey(idempotencyKey: string): void {
  try {
    validateIdempotencyKey(idempotencyKey);
  } catch {
    throw new CaseOutcomeError("CASE_OUTCOME_INVALID");
  }
}

function isEvidenceShape(value: SchoolTargetEvidence): boolean {
  return [
    value.dueDate,
    value.checklistCompleteReceipt,
    value.officialSubmissionReference,
    value.invitationEvidence,
    value.interviewAt,
  ].every((entry) => entry === null || (typeof entry === "string" && entry.length <= MAX_REFERENCE_LENGTH));
}

function isReference(value: string): boolean {
  return value.trim().length > 0 && value.length <= MAX_REFERENCE_LENGTH;
}

function isIsoCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

function isSchoolTargetState(value: string): value is SchoolTargetState {
  return ([
    "candidate",
    "preparing",
    "submitted",
    "interview",
    "waitlisted",
    "accepted",
    "rejected",
    "withdrawn",
  ] as const).includes(value as SchoolTargetState);
}

function isCaseOutcomeCode(value: string): value is CaseOutcomeCode {
  return (["waitlisted", "accepted", "rejected", "withdrawn", "not_submitted", "aborted"] as const).includes(
    value as CaseOutcomeCode,
  );
}

function isCaseOutcomeSource(value: string): value is CaseOutcomeSource {
  return (["official_portal", "official_letter", "advisor_attested"] as const).includes(
    value as CaseOutcomeSource,
  );
}

function assertNow(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new CaseOutcomeError("CASE_OUTCOME_INVALID");
  }
  return value;
}

function assertUuid(value: string): void {
  if (!UUID.test(value)) throw new CaseOutcomeError("CASE_OUTCOME_INVALID");
}
