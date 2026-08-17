import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  approveSchoolOverlay,
  disableSchoolOverlay,
  evaluateSchoolOverlayApproval,
  proposeSchoolOverlay,
  sha256SchoolValue,
  type SchoolBaseRecord,
  type SchoolOverlayRevision,
} from "../../../modules/schools/domain/contract.ts";
import {
  reconcileSchoolOverlay,
  resolveSchoolView,
} from "../../../modules/schools/domain/resolver.ts";

const organizationId = "00000000-0000-4000-8000-000000000001";
const schoolId = "00000000-0000-4000-8000-000000000002";
const requesterId = "00000000-0000-4000-8000-000000000003";
const reviewerId = "00000000-0000-4000-8000-000000000004";
const snapshotId = "snapshot-2026-08-02-a";

function baseRecord(overrides: Partial<SchoolBaseRecord> = {}): SchoolBaseRecord {
  return {
    organizationId,
    schoolId,
    snapshotId,
    sourceSchoolKey: "synthetic-school-001",
    fields: {
      school_name_zh: "Original School",
      school_name_en: "Original School",
      official_website: "https://example.test/original",
      district: "Central",
    },
    ...overrides,
  };
}

function approvedOverlay(
  changes: Parameters<typeof proposeSchoolOverlay>[0]["changes"],
  revisionNumber = 1,
): SchoolOverlayRevision {
  const proposed = proposeSchoolOverlay({
    organizationId,
    schoolId,
    baseSnapshotId: snapshotId,
    revisionId: `overlay-${revisionNumber}`,
    revisionNumber,
    requestedBy: requesterId,
    reason: "Synthetic verified correction",
    changes,
    createdAt: "2026-08-02T10:00:00.000Z",
  });

  return approveSchoolOverlay(proposed, {
    reviewerId,
    reviewerRole: "founder",
    approvedAt: "2026-08-02T10:05:00.000Z",
  });
}

test("resolves the base snapshot with base provenance and a deterministic hash", () => {
  const result = resolveSchoolView(baseRecord(), []);

  assert.equal(result.baseSnapshotId, snapshotId);
  assert.equal(result.overlayRevisionId, null);
  assert.equal(result.fields.school_name_zh, "Original School");
  assert.deepEqual(result.provenance.school_name_zh, {
    sourceKind: "crawler_snapshot",
    sourceSnapshotId: snapshotId,
    sourceSchoolKey: "synthetic-school-001",
    valueSha256: sha256SchoolValue("Original School"),
  });
  assert.match(result.resolutionSha256, /^[0-9a-f]{64}$/);
  assert.equal(result.resolutionSha256, resolveSchoolView(baseRecord(), []).resolutionSha256);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.fields));
  assert.ok(Object.isFrozen(result.provenance));
});

test("applies an approved overlay and records the pinned overlay provenance", () => {
  const original = "Original School";
  const revision = approvedOverlay([
    {
      fieldName: "school_name_zh",
      fieldClass: "identity",
      proposedValue: "Corrected School",
      baseValueSha256: sha256SchoolValue(original),
      evidence: {
        sourceUrl: "https://example.test/evidence/school-name",
        quote: "Corrected School",
      },
    },
  ]);

  const result = resolveSchoolView(baseRecord(), [revision]);

  assert.equal(result.overlayRevisionId, "overlay-1");
  assert.equal(result.overlayRevisionNumber, 1);
  assert.equal(result.fields.school_name_zh, "Corrected School");
  assert.deepEqual(result.provenance.school_name_zh, {
    sourceKind: "approved_overlay",
    sourceSnapshotId: snapshotId,
    sourceSchoolKey: "synthetic-school-001",
    overlayRevisionId: "overlay-1",
    baseValueSha256: sha256SchoolValue(original),
    valueSha256: sha256SchoolValue("Corrected School"),
  });
  assert.match(result.resolutionSha256, /^[0-9a-f]{64}$/);
});

test("disabling the newest overlay rolls back to the prior hash without rewriting history", () => {
  const first = approvedOverlay([
    {
      fieldName: "district",
      fieldClass: "general",
      proposedValue: "Eastern",
      baseValueSha256: sha256SchoolValue("Central"),
      evidence: {
        sourceUrl: "https://example.test/evidence/district-1",
        quote: "Eastern",
      },
    },
  ]);
  const secondProposed = proposeSchoolOverlay({
    organizationId,
    schoolId,
    baseSnapshotId: snapshotId,
    revisionId: "overlay-2",
    revisionNumber: 2,
    requestedBy: requesterId,
    reason: "Synthetic correction follow-up",
    changes: [
      {
        fieldName: "district",
        fieldClass: "general",
        proposedValue: "North",
        baseValueSha256: sha256SchoolValue("Central"),
        evidence: {
          sourceUrl: "https://example.test/evidence/district-2",
          quote: "North",
        },
      },
    ],
    createdAt: "2026-08-02T11:00:00.000Z",
  });
  const second = approveSchoolOverlay(secondProposed, {
    reviewerId,
    reviewerRole: "founder",
    approvedAt: "2026-08-02T11:05:00.000Z",
  });
  const beforeRollback = resolveSchoolView(baseRecord(), [first, second]);
  const disabledSecond = disableSchoolOverlay(second, {
    disabledBy: reviewerId,
    reason: "Synthetic rollback",
    disabledAt: "2026-08-02T12:00:00.000Z",
  });
  const afterRollback = resolveSchoolView(baseRecord(), [first, disabledSecond]);

  assert.equal(beforeRollback.fields.district, "North");
  assert.equal(afterRollback.fields.district, "Eastern");
  assert.equal(afterRollback.resolutionSha256, resolveSchoolView(baseRecord(), [first]).resolutionSha256);
  assert.equal(second.status, "approved");
  assert.equal(disabledSecond.status, "disabled");
  assert.equal(disabledSecond.revisionId, second.revisionId);
});

test("preserves an approved human value and reports a conflict after a new base changes", () => {
  const revision = approvedOverlay([
    {
      fieldName: "district",
      fieldClass: "general",
      proposedValue: "Eastern",
      baseValueSha256: sha256SchoolValue("Central"),
      evidence: {
        sourceUrl: "https://example.test/evidence/district",
        quote: "Eastern",
      },
    },
  ]);
  const newerBase = baseRecord({
    snapshotId: "snapshot-2026-08-03-b",
    fields: {
      ...baseRecord().fields,
      district: "Harbour",
    },
  });

  const result = resolveSchoolView(newerBase, [revision]);
  const reconciliation = reconcileSchoolOverlay(newerBase, revision);

  assert.equal(result.fields.district, "Eastern");
  assert.deepEqual(result.conflicts, [
    {
      fieldName: "district",
      kind: "base_changed",
      previousBaseValueSha256: sha256SchoolValue("Central"),
      currentBaseValueSha256: sha256SchoolValue("Harbour"),
    },
  ]);
  assert.deepEqual(reconciliation, {
    action: "preserve_and_review",
    fields: [
      {
        fieldName: "district",
        kind: "base_changed",
        previousBaseValueSha256: sha256SchoolValue("Central"),
        currentBaseValueSha256: sha256SchoolValue("Harbour"),
      },
    ],
  });
});

test("recognizes a new base value that converges with the override without mutating it", () => {
  const revision = approvedOverlay([
    {
      fieldName: "district",
      fieldClass: "general",
      proposedValue: "Eastern",
      baseValueSha256: sha256SchoolValue("Central"),
      evidence: {
        sourceUrl: "https://example.test/evidence/district",
        quote: "Eastern",
      },
    },
  ]);
  const newerBase = baseRecord({
    snapshotId: "snapshot-2026-08-03-b",
    fields: {
      ...baseRecord().fields,
      district: "Eastern",
    },
  });

  assert.deepEqual(reconcileSchoolOverlay(newerBase, revision), {
    action: "close_override",
    fields: [{ fieldName: "district", kind: "base_matches_override" }],
  });
  assert.equal(revision.status, "approved");
});

test("reconciles every converged field without collapsing a multi-field overlay", () => {
  const revision = approvedOverlay([
    {
      fieldName: "school_name_zh",
      fieldClass: "identity",
      proposedValue: "Corrected School",
      baseValueSha256: sha256SchoolValue("Original School"),
      evidence: {
        sourceUrl: "https://example.test/evidence/school-name",
        quote: "Corrected School",
      },
    },
    {
      fieldName: "district",
      fieldClass: "general",
      proposedValue: "Eastern",
      baseValueSha256: sha256SchoolValue("Central"),
      evidence: {
        sourceUrl: "https://example.test/evidence/district",
        quote: "Eastern",
      },
    },
  ]);
  const newerBase = baseRecord({
    snapshotId: "snapshot-2026-08-03-c",
    fields: {
      ...baseRecord().fields,
      school_name_zh: "Corrected School",
      district: "Eastern",
    },
  });

  assert.deepEqual(reconcileSchoolOverlay(newerBase, revision), {
    action: "close_override",
    fields: [
      { fieldName: "school_name_zh", kind: "base_matches_override" },
      { fieldName: "district", kind: "base_matches_override" },
    ],
  });
});

test("fails closed when an approved revision has no fields", () => {
  const emptyRevision: SchoolOverlayRevision = {
    organizationId,
    schoolId,
    baseSnapshotId: snapshotId,
    revisionId: "overlay-empty",
    revisionNumber: 1,
    requestedBy: requesterId,
    reason: "Synthetic invalid revision",
    changes: [],
    status: "approved",
    createdAt: "2026-08-03T10:00:00.000Z",
    approvedBy: reviewerId,
    approvedRole: "founder",
    approvedAt: "2026-08-03T10:05:00.000Z",
  };

  assert.throws(
    () => reconcileSchoolOverlay(baseRecord(), emptyRevision),
    /SCHOOL_OVERLAY_FIELDS_REQUIRED/,
  );
});

test("requires reviewer separation and role-specific approval", () => {
  assert.deepEqual(
    evaluateSchoolOverlayApproval({
      requestedBy: requesterId,
      reviewerId: requesterId,
      reviewerRole: "founder",
      fieldClasses: ["general"],
    }),
    { allowed: false, code: "SCHOOL_REVIEWER_SELF_REVIEW_DENIED" },
  );
  assert.deepEqual(
    evaluateSchoolOverlayApproval({
      requestedBy: requesterId,
      reviewerId,
      reviewerRole: "data_reviewer",
      fieldClasses: ["identity"],
    }),
    { allowed: false, code: "SCHOOL_IDENTITY_CHANGE_REQUIRES_FOUNDER" },
  );
  assert.deepEqual(
    evaluateSchoolOverlayApproval({
      requestedBy: requesterId,
      reviewerId,
      reviewerRole: "data_reviewer",
      fieldClasses: ["general"],
    }),
    { allowed: true },
  );
  assert.deepEqual(
    evaluateSchoolOverlayApproval({
      requestedBy: requesterId,
      reviewerId,
      reviewerRole: "advisor",
      fieldClasses: ["general"],
    }),
    { allowed: false, code: "SCHOOL_REVIEWER_ROLE_NOT_ALLOWED" },
  );
});

test("rejects duplicate fields, invalid hashes, and non-JSON values", () => {
  assert.throws(
    () =>
      proposeSchoolOverlay({
        organizationId,
        schoolId,
        baseSnapshotId: snapshotId,
        revisionId: "overlay-invalid",
        revisionNumber: 1,
        requestedBy: requesterId,
        reason: "invalid",
        changes: [
          {
            fieldName: "district",
            fieldClass: "general",
            proposedValue: "Eastern",
            baseValueSha256: "not-a-hash",
            evidence: { sourceUrl: "https://example.test/evidence", quote: "Eastern" },
          },
          {
            fieldName: "district",
            fieldClass: "general",
            proposedValue: "North",
            baseValueSha256: sha256SchoolValue("Central"),
            evidence: { sourceUrl: "https://example.test/evidence-2", quote: "North" },
          },
        ],
        createdAt: "2026-08-02T10:00:00.000Z",
      }),
    /SCHOOL_OVERLAY_FIELD_DUPLICATE|SCHOOL_OVERLAY_BASE_HASH_INVALID/,
  );
  assert.throws(
    () => sha256SchoolValue(BigInt(1)),
    /SCHOOL_VALUE_NOT_JSON/,
  );
  const cyclic = {} as Record<string, unknown>;
  cyclic.self = cyclic;
  assert.throws(
    () => sha256SchoolValue(cyclic),
    /SCHOOL_VALUE_NOT_JSON/,
  );
});

test("does not freeze or mutate nested base values while producing a resolved view", () => {
  const nested = { source: "synthetic" };
  const base = baseRecord({ fields: { ...baseRecord().fields, metadata: nested } });

  const result = resolveSchoolView(base, []);

  assert.deepEqual(result.fields.metadata, { source: "synthetic" });
  assert.equal(Object.isFrozen(nested), false);
  assert.equal(Object.isFrozen(result.fields.metadata), true);
});

test("planner payload contains the school FK, immutable tables, and resolution pin contract", async () => {
  const migrationPath = "db/migrations/202608022030_004_expand_school_overlay.sql";
  const migration = await readFile(migrationPath, "utf8");

  assert.doesNotMatch(migration, /CREATE\s+(?:TABLE|INDEX|FUNCTION|TRIGGER)\s+IF\s+NOT\s+EXISTS/i);
  assert.match(migration, /CREATE TABLE schools_schools/);
  assert.match(migration, /CREATE TABLE schools_snapshots/);
  assert.match(migration, /CREATE TABLE schools_snapshot_records/);
  assert.match(migration, /CREATE TABLE schools_overlay_revisions/);
  assert.match(migration, /CREATE TABLE schools_overlay_fields/);
  assert.match(migration, /CREATE TABLE schools_overlay_review_queue/);
  assert.match(migration, /CREATE TABLE schools_resolved_revisions/);
  assert.match(migration, /cases_targets_pinned_resolution_fk/);
  assert.match(migration, /schools_reject_immutable_delete/);
  assert.match(migration, /schools_validate_overlay_approval/);
  assert.match(migration, /schools_validate_snapshot_record_write/);
  assert.match(migration, /schools_validate_overlay_field_write/);
  assert.match(migration, /schools_validate_review_queue_write/);
  assert.match(migration, /schools_validate_resolution_pin/);

  const actualSha = createHash("sha256").update(migration).digest("hex");
  assert.equal(actualSha, "8fe2ba80bddcb3fd264f4f79af4ff34ffc091fe53606676550402d49a482008b");
});
