import type { OrganizationRole } from "../../../access/public.ts";
import type { MutationEffectBundle } from "../../../audit/public.ts";
import type { JsonValue } from "../../../shared/public.ts";

export const RECONSTRUCTION_EVENT_TYPES = Object.freeze([
  "service_case.stage_changed.v1",
  "school_target.state_changed.v1",
  "task.state_changed.v1",
  "document.metadata_recorded.v1",
] as const);

export const RECONSTRUCTION_EVIDENCE_TYPES = Object.freeze([
  "customer_record",
  "document_metadata",
  "system_record",
] as const);

export const RECONSTRUCTION_GAP_TYPES = Object.freeze([
  "missing_event",
  "missing_evidence",
  "uncertain_order",
] as const);

export const RECONSTRUCTION_GAP_REASON_CODES = Object.freeze([
  "SOURCE_UNAVAILABLE",
  "SOURCE_CONFLICT",
  "OCCURRED_AT_UNKNOWN",
] as const);

export const RECONSTRUCTION_COMMAND_TYPES = Object.freeze([
  "create_draft",
  "record_event",
  "record_gap",
  "submit",
  "request_changes",
  "create_next_draft",
  "approve",
  "activate",
  "append_correction",
] as const);

export type ReconstructionEventType = (typeof RECONSTRUCTION_EVENT_TYPES)[number];
export type ReconstructionEvidenceType = (typeof RECONSTRUCTION_EVIDENCE_TYPES)[number];
export type ReconstructionGapType = (typeof RECONSTRUCTION_GAP_TYPES)[number];
export type ReconstructionGapReasonCode = (typeof RECONSTRUCTION_GAP_REASON_CODES)[number];
export type ReconstructionCommandType = (typeof RECONSTRUCTION_COMMAND_TYPES)[number];
export type ReconstructionState =
  | "draft"
  | "submitted"
  | "changes_requested"
  | "approved"
  | "activated"
  | "needs_human";

export type ReconstructionIdempotencyState =
  | "in_progress"
  | "completed"
  | "failed_reconcilable";

export interface ReconstructionActor {
  readonly userId: string;
  readonly organizationId: string;
  readonly role: OrganizationRole;
  readonly sessionId: string;
  readonly capturedSessionVersion: number;
  readonly reauthenticatedAtMs: number | null;
}

export interface ReconstructionServiceCaseBinding {
  readonly organizationId: string;
  readonly serviceCaseId: string;
}

export interface ReconstructionEventInput {
  readonly eventType: ReconstructionEventType;
  readonly occurredAt: string;
  readonly sequenceNo: number;
  readonly evidenceType: ReconstructionEvidenceType;
  readonly evidenceRef: string;
  readonly reportedActorRef?: string;
}

export interface ReconstructionHistoryEvent extends ReconstructionEventInput {
  readonly id: string;
  readonly organizationId: string;
  readonly reconstructionId: string;
  readonly reconstructionVersionId: string;
  readonly versionNo: number;
  readonly recordedAt: string;
  readonly recorderUserId: string;
  readonly correctedByUserId: string | null;
  readonly correctionOfEventId: string | null;
  readonly correctionReasonCode: ReconstructionGapReasonCode | null;
  readonly expectedRecordVersion: number;
}

export interface ReconstructionGapInput {
  readonly gapType: ReconstructionGapType;
  readonly reasonCode: ReconstructionGapReasonCode;
  readonly ownerRef: string;
  readonly resolutionTargetAt: string;
}

export interface ReconstructionHistoryGap extends ReconstructionGapInput {
  readonly id: string;
  readonly organizationId: string;
  readonly reconstructionId: string;
  readonly reconstructionVersionId: string;
  readonly versionNo: number;
  readonly founderDecision: "pending" | "approved";
  readonly recordVersion: number;
}

/** Stable lookup identity. It survives every revision and is never replaced. */
export interface ReconstructionAggregate {
  readonly id: string;
  readonly organizationId: string;
  readonly serviceCaseId: string | null;
  readonly pilotReference: string;
  readonly assignedAdvisorUserId: string;
  readonly currentVersionId: string;
  readonly currentVersionNo: number;
  readonly state: ReconstructionState;
  readonly reviewCycle: number;
  readonly recordVersion: number;
  readonly activatedVersionId: string | null;
}

/** Immutable revision identity. `id` is a reconstruction_version_id, not the aggregate id. */
export interface ReconstructionVersion {
  readonly id: string;
  readonly reconstructionId: string;
  readonly organizationId: string;
  readonly serviceCaseId: string | null;
  readonly pilotReference: string;
  readonly versionNo: number;
  readonly reviewCycle: number;
  readonly state: ReconstructionState;
  readonly recorderUserId: string;
  readonly reviewerUserId: string | null;
  readonly recordVersion: number;
}

export interface ReconstructionResultMetadata {
  readonly outcome: "committed" | "replayed";
  readonly httpStatus: 200;
  readonly retryable: false;
  readonly errorCode: null;
}

export interface ReconstructionResult {
  readonly reconstruction: ReconstructionAggregate;
  readonly version: ReconstructionVersion;
  readonly versions: readonly ReconstructionVersion[];
  readonly events: readonly ReconstructionHistoryEvent[];
  readonly gaps: readonly ReconstructionHistoryGap[];
  readonly metadata: ReconstructionResultMetadata;
}

export interface ReconstructionCommandBase {
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly expectedRecordVersion: number;
}

/** Create is intentionally keyed by organization + opaque pilot reference only. */
export interface ReconstructionCreateCommand extends Omit<ReconstructionCommandBase, "expectedRecordVersion"> {
  readonly pilotReference: string;
}

export interface ReconstructionActivationWrite {
  readonly organizationId: string;
  readonly actor: ReconstructionActor;
  readonly reconstructionId: string;
  readonly expectedRecordVersion: number;
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly activatedAt: string;
  readonly serviceCaseBinding: ReconstructionServiceCaseBinding | null;
  readonly effects: MutationEffectBundle;
}

export interface ReconstructionIdempotencyScope {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly commandType: ReconstructionCommandType;
  readonly aggregateId: string | null;
  readonly pilotReference: string | null;
  readonly expectedRecordVersion: number | null;
  readonly businessPayload: JsonValue;
}

export interface ReconstructionIdempotencyReceipt {
  readonly idempotencyKey: string;
  readonly scope: ReconstructionIdempotencyScope;
  readonly requestHash: string;
  readonly state: ReconstructionIdempotencyState;
  readonly result: ReconstructionResult | null;
  readonly errorCode: ReconstructionErrorCode | null;
}

export interface ReconstructionErrorMetadata {
  readonly httpStatus: 400 | 403 | 404 | 409 | 422 | 503;
  readonly retryable: boolean;
}

export type ReconstructionErrorCode =
  | "RECONSTRUCTION_INVALID_INPUT"
  | "RECONSTRUCTION_ADVISOR_REQUIRED"
  | "RECONSTRUCTION_FOUNDER_REQUIRED"
  | "RECONSTRUCTION_NOT_ASSIGNED"
  | "RECONSTRUCTION_PILOT_NOT_APPROVED"
  | "RECONSTRUCTION_SERVICE_CASE_BINDING_REQUIRED"
  | "RECONSTRUCTION_SERVICE_CASE_NOT_FOUND"
  | "RECONSTRUCTION_SERVICE_CASE_ALREADY_BOUND"
  | "RECONSTRUCTION_NOT_FOUND"
  | "RECONSTRUCTION_STATE_INVALID"
  | "RECONSTRUCTION_ORDER_INVALID"
  | "RECONSTRUCTION_OCCURRED_AT_FUTURE"
  | "RECONSTRUCTION_EVIDENCE_INVALID"
  | "RECONSTRUCTION_REVIEWER_IS_RECORDER"
  | "RECONSTRUCTION_GAP_NOT_APPROVED"
  | "RECONSTRUCTION_CORRECTION_TARGET_INVALID"
  | "RECONSTRUCTION_CORRECTION_OF_CORRECTION"
  | "RECONSTRUCTION_IDEMPOTENCY_KEY_REUSED"
  | "RECONSTRUCTION_IDEMPOTENCY_IN_PROGRESS"
  | "RECONSTRUCTION_COMMIT_OUTCOME_UNKNOWN"
  | "VERSION_CONFLICT";

export const RECONSTRUCTION_ERROR_METADATA: Readonly<
  Record<ReconstructionErrorCode, ReconstructionErrorMetadata>
> = Object.freeze({
  RECONSTRUCTION_INVALID_INPUT: { httpStatus: 400, retryable: false },
  RECONSTRUCTION_ADVISOR_REQUIRED: { httpStatus: 403, retryable: false },
  RECONSTRUCTION_FOUNDER_REQUIRED: { httpStatus: 403, retryable: false },
  RECONSTRUCTION_NOT_ASSIGNED: { httpStatus: 403, retryable: false },
  RECONSTRUCTION_PILOT_NOT_APPROVED: { httpStatus: 403, retryable: false },
  RECONSTRUCTION_SERVICE_CASE_BINDING_REQUIRED: { httpStatus: 422, retryable: false },
  RECONSTRUCTION_SERVICE_CASE_NOT_FOUND: { httpStatus: 404, retryable: false },
  RECONSTRUCTION_SERVICE_CASE_ALREADY_BOUND: { httpStatus: 409, retryable: false },
  RECONSTRUCTION_NOT_FOUND: { httpStatus: 404, retryable: false },
  RECONSTRUCTION_STATE_INVALID: { httpStatus: 409, retryable: false },
  RECONSTRUCTION_ORDER_INVALID: { httpStatus: 422, retryable: false },
  RECONSTRUCTION_OCCURRED_AT_FUTURE: { httpStatus: 422, retryable: false },
  RECONSTRUCTION_EVIDENCE_INVALID: { httpStatus: 422, retryable: false },
  RECONSTRUCTION_REVIEWER_IS_RECORDER: { httpStatus: 403, retryable: false },
  RECONSTRUCTION_GAP_NOT_APPROVED: { httpStatus: 409, retryable: false },
  RECONSTRUCTION_CORRECTION_TARGET_INVALID: { httpStatus: 422, retryable: false },
  RECONSTRUCTION_CORRECTION_OF_CORRECTION: { httpStatus: 422, retryable: false },
  RECONSTRUCTION_IDEMPOTENCY_KEY_REUSED: { httpStatus: 409, retryable: false },
  RECONSTRUCTION_IDEMPOTENCY_IN_PROGRESS: { httpStatus: 409, retryable: false },
  RECONSTRUCTION_COMMIT_OUTCOME_UNKNOWN: { httpStatus: 503, retryable: false },
  VERSION_CONFLICT: { httpStatus: 409, retryable: false },
});

export class ReconstructionError extends Error {
  readonly code: ReconstructionErrorCode;
  readonly currentRecordVersion: number | null;
  readonly httpStatus: ReconstructionErrorMetadata["httpStatus"];
  readonly retryable: boolean;

  constructor(code: ReconstructionErrorCode, currentRecordVersion: number | null = null) {
    super(`Case reconstruction rejected ${code}.`);
    this.name = "ReconstructionError";
    this.code = code;
    this.currentRecordVersion = currentRecordVersion;
    this.httpStatus = RECONSTRUCTION_ERROR_METADATA[code].httpStatus;
    this.retryable = RECONSTRUCTION_ERROR_METADATA[code].retryable;
  }
}
