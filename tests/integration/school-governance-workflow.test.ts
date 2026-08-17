import assert from "node:assert/strict";
import test from "node:test";

import type { MutationEffectBundle } from "../../modules/audit/domain/contract.ts";
import {
  SchoolGovernanceError,
  SchoolGovernanceService,
  type ReconcileSchoolOverlayResult,
  type SchoolChangeReviewResult,
  type SchoolGovernanceRepository,
} from "../../modules/schools/application/governance-service.ts";
import {
  evaluateSchoolOverlayApproval,
  proposeSchoolOverlay,
  sha256SchoolValue,
  type JsonValue,
  type SchoolBaseRecord,
  type SchoolFieldClass,
  type SchoolOverlayRevision,
} from "../../modules/schools/domain/contract.ts";
import { reconcileSchoolOverlay } from "../../modules/schools/domain/resolver.ts";
import {
  SchoolGovernanceRuntimeUnavailable,
  getSchoolGovernanceRuntime,
} from "../../modules/schools/infrastructure/school-governance-runtime.ts";

const DATA_REVIEWER = Object.freeze({
  userId: "11111111-1111-4111-8111-111111111111",
  organizationId: "22222222-2222-4222-8222-222222222222",
  role: "data_reviewer" as const,
  sessionId: "33333333-3333-4333-8333-333333333333",
  capturedSessionVersion: 1,
  reauthenticatedAtMs: 1_754_265_600_000,
});
const REQUESTER_ID = "44444444-4444-4444-8444-444444444444";
const SCHOOL_ID = "55555555-5555-4555-8555-555555555555";
const CHANGE_REQUEST_ID = "66666666-6666-4666-8666-666666666666";
const SNAPSHOT_ID = "77777777-7777-4777-8777-777777777777";
const NEXT_SNAPSHOT_ID = "88888888-8888-4888-8888-888888888888";

test("a Data Reviewer approves an ordinary field with one atomic resolved receipt", async () => {
  const repository = new ApprovalRepository();
  const service = new SchoolGovernanceService({
    repository,
    clock: { nowMs: () => 1_754_265_600_000 },
    createId: sequenceIds(100),
  });

  const result = await service.reviewChangeRequest({
    actor: DATA_REVIEWER,
    changeRequestId: CHANGE_REQUEST_ID,
    command: {
      decision: "approve",
      expectedRecordVersion: 1,
      reason: "Evidence confirms the ordinary field correction.",
      requestId: "request-p2-06-review-001",
      idempotencyKey: "school-governance-review-001",
    },
  });

  assert.deepEqual(result, {
    changeRequestId: CHANGE_REQUEST_ID,
    schoolId: SCHOOL_ID,
    overlayRevisionId: CHANGE_REQUEST_ID,
    resolvedRevisionId: "00000000-0000-4000-8000-000000000101",
    status: "approved",
    recordVersion: 2,
  });
  assert.deepEqual(repository.snapshot(), {
    decisions: 1,
    resolvedRevisions: 1,
    audits: 1,
    outbox: 1,
  });
  assert.doesNotMatch(
    JSON.stringify(repository.lastEffects),
    /ordinary field correction|Evidence confirms/i,
  );
});

test("the requester cannot review their own School change", async () => {
  const repository = new ApprovalRepository();
  const service = governanceService(repository, 200);

  await assert.rejects(
    service.reviewChangeRequest({
      actor: { ...DATA_REVIEWER, userId: REQUESTER_ID, role: "founder" },
      changeRequestId: CHANGE_REQUEST_ID,
      command: reviewCommand("school-governance-review-002"),
    }),
    governanceError("SCHOOL_GOVERNANCE_SELF_REVIEW_DENIED"),
  );
  assert.deepEqual(repository.snapshot(), {
    decisions: 0,
    resolvedRevisions: 0,
    audits: 0,
    outbox: 0,
  });
});

test("identity-class School changes require a Founder", async () => {
  const repository = new ApprovalRepository();
  repository.fieldClasses = ["identity"];
  const service = governanceService(repository, 300);

  await assert.rejects(
    service.reviewChangeRequest({
      actor: DATA_REVIEWER,
      changeRequestId: CHANGE_REQUEST_ID,
      command: reviewCommand("school-governance-review-003"),
    }),
    governanceError("SCHOOL_GOVERNANCE_IDENTITY_REQUIRES_FOUNDER"),
  );
  assert.equal(repository.snapshot().decisions, 0);

  const result = await service.reviewChangeRequest({
    actor: { ...DATA_REVIEWER, role: "founder" },
    changeRequestId: CHANGE_REQUEST_ID,
    command: reviewCommand("school-governance-review-004"),
  });
  assert.equal(result.status, "approved");
  assert.equal(repository.snapshot().resolvedRevisions, 1);
});

test("a matching immutable snapshot closes the approved override", async () => {
  const repository = new ReconciliationRepository("Eastern");
  const service = governanceService(repository, 400);

  const result = await service.reconcileApprovedOverlay({
    actor: DATA_REVIEWER,
    schoolId: SCHOOL_ID,
    overlayRevisionId: CHANGE_REQUEST_ID,
    command: reconcileCommand("school-governance-reconcile-001"),
  });

  assert.equal(result.action, "closed_override");
  assert.equal(result.reviewItemId, null);
  assert.equal(repository.resolvedDistrict, "Eastern");
  assert.equal(repository.immutableBase.fields.district, "Eastern");
  assert.deepEqual(repository.snapshot(), {
    closedOverrides: 1,
    conflictReviews: 0,
    resolvedRevisions: 1,
    audits: 1,
    outbox: 1,
  });
});

test("a conflicting snapshot preserves the approved human value and appends review", async () => {
  const repository = new ReconciliationRepository("Northern");
  const service = governanceService(repository, 500);

  const result = await service.reconcileApprovedOverlay({
    actor: DATA_REVIEWER,
    schoolId: SCHOOL_ID,
    overlayRevisionId: CHANGE_REQUEST_ID,
    command: reconcileCommand("school-governance-reconcile-002"),
  });

  assert.equal(result.action, "preserved_and_review");
  assert.ok(result.reviewItemId);
  assert.equal(repository.resolvedDistrict, "Eastern");
  assert.equal(repository.immutableBase.fields.district, "Northern");
  assert.deepEqual(repository.snapshot(), {
    closedOverrides: 0,
    conflictReviews: 1,
    resolvedRevisions: 1,
    audits: 1,
    outbox: 1,
  });
});

test("rejection appends a decision without activating a resolved revision", async () => {
  const repository = new ApprovalRepository();
  const service = governanceService(repository, 600);

  const result = await service.reviewChangeRequest({
    actor: DATA_REVIEWER,
    changeRequestId: CHANGE_REQUEST_ID,
    command: reviewCommand("school-governance-review-005", { decision: "reject" }),
  });

  assert.equal(result.status, "rejected");
  assert.equal(result.resolvedRevisionId, null);
  assert.deepEqual(repository.snapshot(), {
    decisions: 1,
    resolvedRevisions: 0,
    audits: 1,
    outbox: 1,
  });
});

test("stale review and changed idempotency reuse are rejected without another decision", async () => {
  const staleRepository = new ApprovalRepository();
  const staleService = governanceService(staleRepository, 700);
  await assert.rejects(
    staleService.reviewChangeRequest({
      actor: DATA_REVIEWER,
      changeRequestId: CHANGE_REQUEST_ID,
      command: reviewCommand("school-governance-review-006", { expectedRecordVersion: 2 }),
    }),
    governanceError("SCHOOL_GOVERNANCE_STALE_VERSION"),
  );

  const repository = new ApprovalRepository();
  const service = governanceService(repository, 800);
  const command = reviewCommand("school-governance-review-007");
  const first = await service.reviewChangeRequest({
    actor: DATA_REVIEWER,
    changeRequestId: CHANGE_REQUEST_ID,
    command,
  });
  assert.deepEqual(
    await service.reviewChangeRequest({
      actor: DATA_REVIEWER,
      changeRequestId: CHANGE_REQUEST_ID,
      command,
    }),
    first,
  );
  await assert.rejects(
    service.reviewChangeRequest({
      actor: DATA_REVIEWER,
      changeRequestId: CHANGE_REQUEST_ID,
      command: { ...command, reason: "A changed decision payload." },
    }),
    governanceError("SCHOOL_GOVERNANCE_IDEMPOTENCY_KEY_REUSED"),
  );
  assert.equal(repository.snapshot().decisions, 1);
});

test("a pre-commit failure leaves decision, resolved revision, audit, and outbox absent", async () => {
  const repository = new ApprovalRepository();
  repository.failOnceBeforeCommit();
  const service = governanceService(repository, 900);

  await assert.rejects(
    service.reviewChangeRequest({
      actor: DATA_REVIEWER,
      changeRequestId: CHANGE_REQUEST_ID,
      command: reviewCommand("school-governance-review-008"),
    }),
    /synthetic governance transaction failure/,
  );
  assert.deepEqual(repository.snapshot(), {
    decisions: 0,
    resolvedRevisions: 0,
    audits: 0,
    outbox: 0,
  });
});

test("production School governance fails closed without an HK RDS runtime", () => {
  assert.throws(() => getSchoolGovernanceRuntime(), SchoolGovernanceRuntimeUnavailable);
});

class ApprovalRepository implements SchoolGovernanceRepository {
  requestedBy = REQUESTER_ID;
  fieldClasses: readonly SchoolFieldClass[] = ["general"];
  lastEffects: MutationEffectBundle | null = null;
  private decisions = 0;
  private resolvedRevisions = 0;
  private recordVersion = 1;
  private status: "submitted" | "approved" | "rejected" = "submitted";
  private readonly idempotencyResults = new Map<
    string,
    { readonly requestHash: string; readonly result: SchoolChangeReviewResult }
  >();
  private failNextCommit = false;

  failOnceBeforeCommit(): void {
    this.failNextCommit = true;
  }

  async reviewChangeRequest(
    input: Parameters<SchoolGovernanceRepository["reviewChangeRequest"]>[0],
  ) {
    const scope = `${input.organizationId}:${input.actorUserId}:${input.idempotencyKey}`;
    const replay = this.idempotencyResults.get(scope);
    if (replay) {
      if (replay.requestHash !== input.requestHash) {
        throw new SchoolGovernanceError("SCHOOL_GOVERNANCE_IDEMPOTENCY_KEY_REUSED");
      }
      return replay.result;
    }
    if (input.expectedRecordVersion !== this.recordVersion) {
      throw new SchoolGovernanceError("SCHOOL_GOVERNANCE_STALE_VERSION");
    }
    if (this.status !== "submitted") {
      throw new SchoolGovernanceError("SCHOOL_GOVERNANCE_CONFLICT");
    }
    const decision = evaluateSchoolOverlayApproval({
      requestedBy: this.requestedBy,
      reviewerId: input.actorUserId,
      reviewerRole: input.reviewerRole,
      fieldClasses: this.fieldClasses,
    });
    if (!decision.allowed) {
      if (decision.code === "SCHOOL_REVIEWER_SELF_REVIEW_DENIED") {
        throw new SchoolGovernanceError("SCHOOL_GOVERNANCE_SELF_REVIEW_DENIED");
      }
      if (decision.code === "SCHOOL_IDENTITY_CHANGE_REQUIRES_FOUNDER") {
        throw new SchoolGovernanceError("SCHOOL_GOVERNANCE_IDENTITY_REQUIRES_FOUNDER");
      }
      throw new SchoolGovernanceError("SCHOOL_GOVERNANCE_REVIEWER_REQUIRED");
    }
    assert.equal(input.actorUserId, DATA_REVIEWER.userId);
    assert.ok(input.reviewerRole === "data_reviewer" || input.reviewerRole === "founder");
    assert.notEqual(input.actorUserId, REQUESTER_ID);
    const status = input.decision === "approve" ? "approved" : "rejected";
    const result = Object.freeze({
      changeRequestId: input.changeRequestId,
      schoolId: SCHOOL_ID,
      overlayRevisionId: CHANGE_REQUEST_ID,
      resolvedRevisionId: input.resolvedRevisionId,
      status,
      recordVersion: this.recordVersion + 1,
    });
    if (this.failNextCommit) {
      this.failNextCommit = false;
      throw new Error("synthetic governance transaction failure");
    }
    this.decisions += 1;
    if (input.decision === "approve") this.resolvedRevisions += 1;
    this.lastEffects = input.effects;
    this.recordVersion += 1;
    this.status = status;
    this.idempotencyResults.set(scope, { requestHash: input.requestHash, result });
    return result;
  }

  async reconcileApprovedOverlay(): Promise<never> {
    throw new Error("not implemented in this tracer bullet");
  }

  snapshot() {
    return Object.freeze({
      decisions: this.decisions,
      resolvedRevisions: this.resolvedRevisions,
      audits: this.lastEffects ? 1 : 0,
      outbox: this.lastEffects ? 1 : 0,
    });
  }
}

class ReconciliationRepository implements SchoolGovernanceRepository {
  readonly immutableBase: SchoolBaseRecord;
  readonly overlay: SchoolOverlayRevision;
  resolvedDistrict: JsonValue = "Eastern";
  private closedOverrides = 0;
  private conflictReviews = 0;
  private resolvedRevisions = 0;
  private effects: MutationEffectBundle | null = null;

  constructor(nextBaseDistrict: string) {
    this.immutableBase = Object.freeze({
      organizationId: DATA_REVIEWER.organizationId,
      schoolId: SCHOOL_ID,
      snapshotId: NEXT_SNAPSHOT_ID,
      sourceSchoolKey: "crawler-school-001",
      fields: Object.freeze({ district: nextBaseDistrict }),
    });
    const candidate = proposeSchoolOverlay({
      organizationId: DATA_REVIEWER.organizationId,
      schoolId: SCHOOL_ID,
      baseSnapshotId: SNAPSHOT_ID,
      revisionId: CHANGE_REQUEST_ID,
      revisionNumber: 1,
      requestedBy: REQUESTER_ID,
      reason: "Approved evidence-backed district correction.",
      changes: [
        {
          fieldName: "district",
          fieldClass: "general",
          proposedValue: "Eastern",
          baseValueSha256: sha256SchoolValue("Central"),
          evidence: {
            sourceUrl: "https://example.test/evidence/district",
            quote: "District: Eastern",
          },
        },
      ],
      createdAt: "2026-08-09T00:00:00.000Z",
    });
    this.overlay = Object.freeze({
      ...candidate,
      status: "approved",
      approvedBy: DATA_REVIEWER.userId,
      approvedRole: "data_reviewer",
      approvedAt: "2026-08-09T01:00:00.000Z",
    });
  }

  async reviewChangeRequest(): Promise<never> {
    throw new Error("not used by reconciliation tests");
  }

  async reconcileApprovedOverlay(
    input: Parameters<SchoolGovernanceRepository["reconcileApprovedOverlay"]>[0],
  ): Promise<ReconcileSchoolOverlayResult> {
    assert.equal(input.snapshotId, NEXT_SNAPSHOT_ID);
    assert.equal(input.expectedOverlayRecordVersion, 1);
    const decision = reconcileSchoolOverlay(this.immutableBase, this.overlay);
    const action: ReconcileSchoolOverlayResult["action"] =
      decision.action === "close_override"
        ? "closed_override"
        : decision.action === "preserve_and_review"
          ? "preserved_and_review"
          : "retained_override";
    if (action === "closed_override") {
      this.closedOverrides += 1;
      this.resolvedDistrict = this.immutableBase.fields.district;
    } else if (action === "preserved_and_review") {
      this.conflictReviews += 1;
      this.resolvedDistrict = this.overlay.changes[0].proposedValue;
    }
    this.resolvedRevisions += 1;
    this.effects = input.effects;
    return Object.freeze({
      schoolId: input.schoolId,
      overlayRevisionId: input.overlayRevisionId,
      snapshotId: input.snapshotId,
      action,
      resolvedRevisionId: input.resolvedRevisionId,
      reviewItemId: action === "preserved_and_review" ? input.reviewItemId : null,
      recordVersion: 2,
    });
  }

  snapshot() {
    return Object.freeze({
      closedOverrides: this.closedOverrides,
      conflictReviews: this.conflictReviews,
      resolvedRevisions: this.resolvedRevisions,
      audits: this.effects ? 1 : 0,
      outbox: this.effects ? 1 : 0,
    });
  }
}

function governanceService(repository: SchoolGovernanceRepository, start: number) {
  return new SchoolGovernanceService({
    repository,
    clock: { nowMs: () => 1_754_265_600_000 },
    createId: sequenceIds(start),
  });
}

function reviewCommand(
  idempotencyKey: string,
  overrides: Partial<{
    decision: "approve" | "reject";
    expectedRecordVersion: number;
    reason: string;
  }> = {},
) {
  return {
    decision: "approve" as const,
    expectedRecordVersion: 1,
    reason: "Independent evidence supports this governed change.",
    requestId: `request-${idempotencyKey}`,
    idempotencyKey,
    ...overrides,
  };
}

function reconcileCommand(idempotencyKey: string) {
  return {
    snapshotId: NEXT_SNAPSHOT_ID,
    expectedOverlayRecordVersion: 1,
    requestId: `request-${idempotencyKey}`,
    idempotencyKey,
  };
}

function governanceError(code: SchoolGovernanceError["code"]) {
  return (error: unknown) => {
    assert.ok(error instanceof SchoolGovernanceError);
    assert.equal(error.code, code);
    return true;
  };
}

function sequenceIds(start: number): () => string {
  let current = start;
  return () => {
    current += 1;
    return `00000000-0000-4000-8000-${String(current).padStart(12, "0")}`;
  };
}
