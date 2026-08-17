import { randomUUID } from "node:crypto";

import {
  buildAtomicMutationEffects,
  buildAuditEvent,
  buildOutboxMessage,
  type MutationEffectBundle,
} from "../../audit/public.ts";
import type { IdentitySessionActor } from "../../identity/public.ts";
import { hashRequestPayload, validateIdempotencyKey } from "../../shared/public.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type SchoolGovernanceReviewerRole = "founder" | "data_reviewer";
export type SchoolReviewDecision = "approve" | "reject";

export interface ReviewSchoolChangeCommand {
  readonly decision: SchoolReviewDecision;
  readonly expectedRecordVersion: number;
  readonly reason: string;
  readonly requestId: string;
  readonly idempotencyKey: string;
}

export interface ReconcileSchoolOverlayCommand {
  readonly snapshotId: string;
  readonly expectedOverlayRecordVersion: number;
  readonly requestId: string;
  readonly idempotencyKey: string;
}

export interface SchoolChangeReviewResult {
  readonly changeRequestId: string;
  readonly schoolId: string;
  readonly overlayRevisionId: string;
  readonly resolvedRevisionId: string | null;
  readonly status: "approved" | "rejected";
  readonly recordVersion: number;
}

export interface ReconcileSchoolOverlayResult {
  readonly schoolId: string;
  readonly overlayRevisionId: string;
  readonly snapshotId: string;
  readonly action: "closed_override" | "preserved_and_review" | "retained_override";
  readonly resolvedRevisionId: string;
  readonly reviewItemId: string | null;
  readonly recordVersion: number;
}

export interface SchoolGovernanceRepository {
  /**
   * The HK RDS adapter must lock the request, candidate overlay, actor policy,
   * current resolved view, and idempotency row. It re-evaluates requester
   * separation and field-class authority before atomically appending the
   * decision, optional active resolved revision, audit, and outbox.
   */
  reviewChangeRequest(input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly reviewerRole: SchoolGovernanceReviewerRole;
    readonly changeRequestId: string;
    readonly decision: SchoolReviewDecision;
    readonly expectedRecordVersion: number;
    readonly reason: string;
    readonly resolvedRevisionId: string | null;
    readonly requestId: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly reviewedAtMs: number;
    readonly effects: MutationEffectBundle;
  }): Promise<SchoolChangeReviewResult>;

  reconcileApprovedOverlay(input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly reviewerRole: SchoolGovernanceReviewerRole;
    readonly schoolId: string;
    readonly overlayRevisionId: string;
    readonly snapshotId: string;
    readonly expectedOverlayRecordVersion: number;
    readonly resolvedRevisionId: string;
    readonly reviewItemId: string;
    readonly requestId: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly reconciledAtMs: number;
    readonly effects: MutationEffectBundle;
  }): Promise<ReconcileSchoolOverlayResult>;
}

export type SchoolGovernanceErrorCode =
  | "SCHOOL_GOVERNANCE_INVALID"
  | "SCHOOL_GOVERNANCE_REVIEWER_REQUIRED"
  | "SCHOOL_GOVERNANCE_SELF_REVIEW_DENIED"
  | "SCHOOL_GOVERNANCE_IDENTITY_REQUIRES_FOUNDER"
  | "SCHOOL_GOVERNANCE_NOT_FOUND"
  | "SCHOOL_GOVERNANCE_STALE_VERSION"
  | "SCHOOL_GOVERNANCE_CONFLICT"
  | "SCHOOL_GOVERNANCE_IDEMPOTENCY_KEY_REUSED"
  | "SCHOOL_GOVERNANCE_IDEMPOTENCY_IN_PROGRESS";

export class SchoolGovernanceError extends Error {
  readonly code: SchoolGovernanceErrorCode;

  constructor(code: SchoolGovernanceErrorCode) {
    super(`School governance rejected ${code}.`);
    this.name = "SchoolGovernanceError";
    this.code = code;
  }
}

export class SchoolGovernanceService {
  private readonly repository: SchoolGovernanceRepository;
  private readonly clock: { nowMs(): number };
  private readonly createId: () => string;

  constructor(options: {
    readonly repository: SchoolGovernanceRepository;
    readonly clock?: { nowMs(): number };
    readonly createId?: () => string;
  }) {
    this.repository = options.repository;
    this.clock = options.clock ?? { nowMs: () => Date.now() };
    this.createId = options.createId ?? randomUUID;
  }

  async reviewChangeRequest(input: {
    readonly actor: IdentitySessionActor;
    readonly changeRequestId: string;
    readonly command: ReviewSchoolChangeCommand;
  }): Promise<SchoolChangeReviewResult> {
    const reviewerRole = assertReviewer(input.actor);
    assertUuid(input.changeRequestId);
    const command = validateReviewCommand(input.command);
    const reviewedAtMs = validNow(this.clock.nowMs());
    const resolvedRevisionId = command.decision === "approve" ? this.createId() : null;
    const auditId = this.createId();
    const outboxId = this.createId();
    for (const id of [resolvedRevisionId, auditId, outboxId]) {
      if (id !== null) assertUuid(id);
    }

    const status = command.decision === "approve" ? "approved" : "rejected";
    const occurredAt = new Date(reviewedAtMs).toISOString();
    const eventType = `schools.change_request.${status}`;
    const audit = buildAuditEvent({
      id: auditId,
      organizationId: input.actor.organizationId,
      actorUserId: input.actor.userId,
      actorKind: "user",
      eventType,
      eventVersion: 1,
      action: command.decision,
      resourceType: "SchoolChangeRequest",
      resourceId: input.changeRequestId,
      outcome: "succeeded",
      requestId: command.requestId,
      occurredAt,
      metadata: {
        effect_type: "school_change_reviewed",
        next_version: command.expectedRecordVersion + 1,
        status,
      },
    });
    const outbox = buildOutboxMessage({
      id: outboxId,
      auditEventId: auditId,
      organizationId: input.actor.organizationId,
      aggregateType: "SchoolChangeRequest",
      aggregateId: input.changeRequestId,
      eventType,
      eventVersion: 1,
      idempotencyKey: `school-change-review-${outboxId}`,
      requestId: command.requestId,
      payload: {
        aggregate_id: input.changeRequestId,
        effect_type: "school_change_reviewed",
        record_version: command.expectedRecordVersion + 1,
        request_id: command.requestId,
        status,
      },
      availableAt: occurredAt,
      createdAt: occurredAt,
    });

    return this.repository.reviewChangeRequest({
      organizationId: input.actor.organizationId,
      actorUserId: input.actor.userId,
      reviewerRole,
      changeRequestId: input.changeRequestId,
      decision: command.decision,
      expectedRecordVersion: command.expectedRecordVersion,
      reason: command.reason,
      resolvedRevisionId,
      requestId: command.requestId,
      idempotencyKey: command.idempotencyKey,
      requestHash: hashRequestPayload({
        changeRequestId: input.changeRequestId,
        decision: command.decision,
        expectedRecordVersion: command.expectedRecordVersion,
        reason: command.reason,
      }),
      reviewedAtMs,
      effects: buildAtomicMutationEffects({ audit, outbox }),
    });
  }

  async reconcileApprovedOverlay(input: {
    readonly actor: IdentitySessionActor;
    readonly schoolId: string;
    readonly overlayRevisionId: string;
    readonly command: ReconcileSchoolOverlayCommand;
  }): Promise<ReconcileSchoolOverlayResult> {
    const reviewerRole = assertReviewer(input.actor);
    assertUuid(input.schoolId);
    assertUuid(input.overlayRevisionId);
    const command = validateReconcileCommand(input.command);
    const reconciledAtMs = validNow(this.clock.nowMs());
    const resolvedRevisionId = this.createId();
    const reviewItemId = this.createId();
    const auditId = this.createId();
    const outboxId = this.createId();
    for (const id of [resolvedRevisionId, reviewItemId, auditId, outboxId]) assertUuid(id);

    const occurredAt = new Date(reconciledAtMs).toISOString();
    const eventType = "schools.overlay_snapshot_reconciled";
    const audit = buildAuditEvent({
      id: auditId,
      organizationId: input.actor.organizationId,
      actorUserId: input.actor.userId,
      actorKind: "user",
      eventType,
      eventVersion: 1,
      action: "reconcile",
      resourceType: "OverlayRevision",
      resourceId: input.overlayRevisionId,
      outcome: "succeeded",
      requestId: command.requestId,
      occurredAt,
      metadata: {
        effect_type: "school_overlay_reconciled",
        next_version: command.expectedOverlayRecordVersion + 1,
        status: "evaluated",
      },
    });
    const outbox = buildOutboxMessage({
      id: outboxId,
      auditEventId: auditId,
      organizationId: input.actor.organizationId,
      aggregateType: "OverlayRevision",
      aggregateId: input.overlayRevisionId,
      eventType,
      eventVersion: 1,
      idempotencyKey: `school-overlay-reconcile-${outboxId}`,
      requestId: command.requestId,
      payload: {
        aggregate_id: input.overlayRevisionId,
        effect_type: "school_overlay_reconciled",
        record_version: command.expectedOverlayRecordVersion + 1,
        request_id: command.requestId,
        status: "evaluated",
      },
      availableAt: occurredAt,
      createdAt: occurredAt,
    });

    return this.repository.reconcileApprovedOverlay({
      organizationId: input.actor.organizationId,
      actorUserId: input.actor.userId,
      reviewerRole,
      schoolId: input.schoolId,
      overlayRevisionId: input.overlayRevisionId,
      snapshotId: command.snapshotId,
      expectedOverlayRecordVersion: command.expectedOverlayRecordVersion,
      resolvedRevisionId,
      reviewItemId,
      requestId: command.requestId,
      idempotencyKey: command.idempotencyKey,
      requestHash: hashRequestPayload({
        expectedOverlayRecordVersion: command.expectedOverlayRecordVersion,
        overlayRevisionId: input.overlayRevisionId,
        schoolId: input.schoolId,
        snapshotId: command.snapshotId,
      }),
      reconciledAtMs,
      effects: buildAtomicMutationEffects({ audit, outbox }),
    });
  }
}

function assertReviewer(actor: IdentitySessionActor): SchoolGovernanceReviewerRole {
  if (!UUID.test(actor.organizationId) || !UUID.test(actor.userId)) {
    throw new SchoolGovernanceError("SCHOOL_GOVERNANCE_REVIEWER_REQUIRED");
  }
  if (actor.role === "founder" || actor.role === "data_reviewer") return actor.role;
  throw new SchoolGovernanceError("SCHOOL_GOVERNANCE_REVIEWER_REQUIRED");
}

function validateReviewCommand(command: ReviewSchoolChangeCommand): ReviewSchoolChangeCommand {
  if (command.decision !== "approve" && command.decision !== "reject") invalid();
  if (!Number.isSafeInteger(command.expectedRecordVersion) || command.expectedRecordVersion < 1) {
    invalid();
  }
  const reason = nonBlank(command.reason, 1_024);
  if (!REQUEST_ID.test(command.requestId)) invalid();
  try {
    validateIdempotencyKey(command.idempotencyKey);
  } catch {
    invalid();
  }
  return { ...command, reason };
}

function validateReconcileCommand(
  command: ReconcileSchoolOverlayCommand,
): ReconcileSchoolOverlayCommand {
  assertUuid(command.snapshotId);
  if (
    !Number.isSafeInteger(command.expectedOverlayRecordVersion) ||
    command.expectedOverlayRecordVersion < 1
  ) {
    invalid();
  }
  if (!REQUEST_ID.test(command.requestId)) invalid();
  try {
    validateIdempotencyKey(command.idempotencyKey);
  } catch {
    invalid();
  }
  return command;
}

function nonBlank(value: unknown, maxLength: number): string {
  if (typeof value !== "string") invalid();
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength) invalid();
  return normalized;
}

function assertUuid(value: string): void {
  if (!UUID.test(value)) invalid();
}

function validNow(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) invalid();
  return value;
}

function invalid(): never {
  throw new SchoolGovernanceError("SCHOOL_GOVERNANCE_INVALID");
}
