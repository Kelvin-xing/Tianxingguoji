import assert from "node:assert/strict";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  BackfillPreviewContractError,
  createBackfillPreview,
} from "../../scripts/backfill/preview.ts";
import {
  BackfillLedgerContractError,
  assertExactBatchApproval,
  createImportLedgerEntry,
  evaluateBackfillResume,
} from "../../modules/operations/import-ledger.ts";

const sourceRows = [
  {
    sourceRecordReference: "source-record-002",
    sourceEntity: "student",
    fields: {
      external_token: "synthetic-002",
      intake_route: "entry",
    },
  },
  {
    sourceRecordReference: "source-record-001",
    sourceEntity: "student",
    fields: {
      external_token: "synthetic-001",
      intake_route: "transfer",
    },
  },
] as const;

const mapping = {
  mappingVersion: "k12-student-mapping-v1",
  sourceEntity: "student",
  targetEntity: "student",
  fields: [
    {
      sourceField: "external_token",
      targetField: "external_reference",
      disposition: "map",
    },
    {
      sourceField: "intake_route",
      targetField: "intake_route",
      disposition: "map",
    },
  ],
  requiredTargetFields: ["external_reference", "intake_route"],
} as const;

const createPassPreview = () =>
  createBackfillPreview({
    sourceSnapshot: {
      sourceKind: "synthetic",
      sourceVersion: "synthetic-snapshot-2026-08-07",
      rows: sourceRows,
    },
    mapping,
    schemaVersion: "release1-k12-schema-v1",
  });

test("emits one deterministic no-write reconciliation report and immutable import ledger receipt", () => {
  const preview = createPassPreview();
  const reorderedPreview = createBackfillPreview({
    sourceSnapshot: {
      sourceKind: "synthetic",
      sourceVersion: "synthetic-snapshot-2026-08-07",
      rows: [...sourceRows].reverse(),
    },
    mapping,
    schemaVersion: "release1-k12-schema-v1",
  });

  assert.deepEqual(preview, reorderedPreview);
  assert.deepEqual(preview.execution, {
    mode: "preview_only",
    sourceWrites: "forbidden",
    targetWrites: "forbidden",
  });
  assert.deepEqual(preview.counts, {
    source: 2,
    accepted: 2,
    rejected: 0,
    target: 2,
  });
  assert.equal(preview.reconciliation.status, "reconciled");
  assert.equal(preview.reconciliation.unexplainedDifference, 0);
  assert.deepEqual(preview.rejections, []);
  assert.match(preview.resumeKey, /^backfill:[a-f0-9]{64}$/);
  assert.match(preview.hashes.sourceSha256, /^[a-f0-9]{64}$/);
  assert.match(preview.hashes.mappingSha256, /^[a-f0-9]{64}$/);
  assert.match(preview.hashes.acceptedTargetSha256, /^[a-f0-9]{64}$/);
  assert.match(preview.hashes.reportSha256, /^[a-f0-9]{64}$/);

  const ledger = createImportLedgerEntry(preview);
  assert.equal(ledger.status, "awaiting_data_owner_approval");
  assert.equal(ledger.resumeKey, preview.resumeKey);
  assert.equal(Object.isFrozen(ledger), true);
  assert.equal(Object.isFrozen(ledger.source), true);
  assert.deepEqual(evaluateBackfillResume(ledger, preview), { action: "replay" });
  assert.throws(
    () => assertExactBatchApproval(ledger, null),
    (error: unknown) =>
      error instanceof BackfillLedgerContractError &&
      error.code === "BACKFILL_MAPPING_APPROVAL_REQUIRED",
  );
  assert.doesNotThrow(() =>
    assertExactBatchApproval(ledger, {
      approvedByRole: "data_owner",
      approvedBatchReportSha256: preview.hashes.reportSha256,
      approvalReference: "approval-p2-11-synthetic",
    }),
  );
  assert.throws(
    () =>
      assertExactBatchApproval(ledger, {
        approvedByRole: "data_owner",
        approvedBatchReportSha256: "0".repeat(64),
        approvalReference: "approval-for-a-different-report",
      }),
    (error: unknown) =>
      error instanceof BackfillLedgerContractError &&
      error.code === "BACKFILL_APPROVAL_PAYLOAD_MISMATCH",
  );
});

test("classifies every source row and stops at named rejects without producing an apply-ready ledger", () => {
  const preview = createBackfillPreview({
    sourceSnapshot: {
      sourceKind: "synthetic",
      sourceVersion: "synthetic-snapshot-with-reject-v1",
      rows: [
        ...sourceRows,
        {
          sourceRecordReference: "source-record-003",
          sourceEntity: "student",
          fields: {
            external_token: "synthetic-003",
            intake_route: "entry",
            legacy_marker: "unmapped",
          },
        },
        {
          sourceRecordReference: "source-record-004",
          sourceEntity: "student",
          fields: {
            external_token: "synthetic-004",
          },
        },
      ],
    },
    mapping,
    schemaVersion: "release1-k12-schema-v1",
  });

  assert.deepEqual(preview.counts, {
    source: 4,
    accepted: 2,
    rejected: 2,
    target: 2,
  });
  assert.deepEqual(preview.rejections, [
    {
      sourceRecordReference: "source-record-003",
      code: "SOURCE_FIELD_UNMAPPED",
      fields: ["legacy_marker"],
    },
    {
      sourceRecordReference: "source-record-004",
      code: "REQUIRED_TARGET_FIELD_MISSING",
      fields: ["intake_route"],
    },
  ]);
  assert.equal(preview.reconciliation.status, "needs_human");
  assert.equal(preview.reconciliation.unexplainedDifference, 0);
  assert.throws(
    () => createImportLedgerEntry(preview),
    (error: unknown) =>
      error instanceof BackfillLedgerContractError && error.code === "BACKFILL_REJECTS_PRESENT",
  );
});

test("rejects malformed mappings and changed resume payloads before an invocation can be approved", () => {
  assert.throws(
    () =>
      createBackfillPreview({
        sourceSnapshot: {
          sourceKind: "synthetic",
          sourceVersion: "synthetic-snapshot-v1",
          rows: sourceRows,
        },
        mapping: {
          ...mapping,
          fields: [
            ...mapping.fields,
            {
              sourceField: "external_token",
              targetField: "duplicate_target",
              disposition: "map",
            },
          ],
        },
        schemaVersion: "release1-k12-schema-v1",
      }),
    (error: unknown) =>
      error instanceof BackfillPreviewContractError && error.code === "MAPPING_SOURCE_FIELD_DUPLICATE",
  );

  const preview = createPassPreview();
  const ledger = createImportLedgerEntry(preview);
  const changedPreview = createBackfillPreview({
    sourceSnapshot: {
      sourceKind: "synthetic",
      sourceVersion: "synthetic-snapshot-2026-08-07",
      rows: [
        ...sourceRows,
        {
          sourceRecordReference: "source-record-004",
          sourceEntity: "student",
          fields: {
            external_token: "synthetic-004",
            intake_route: "entry",
          },
        },
      ],
    },
    mapping,
    schemaVersion: "release1-k12-schema-v1",
  });

  assert.deepEqual(evaluateBackfillResume(ledger, changedPreview), {
    action: "conflict",
    code: "BACKFILL_RESUME_PAYLOAD_CONFLICT",
  });

  const changedMappingPreview = createBackfillPreview({
    sourceSnapshot: {
      sourceKind: "synthetic",
      sourceVersion: "synthetic-snapshot-2026-08-07",
      rows: sourceRows,
    },
    mapping: {
      ...mapping,
      targetEntity: "student_import",
    },
    schemaVersion: "release1-k12-schema-v1",
  });
  assert.deepEqual(evaluateBackfillResume(ledger, changedMappingPreview), {
    action: "conflict",
    code: "BACKFILL_RESUME_PAYLOAD_CONFLICT",
  });
});

test("fails closed unless the source is explicitly marked synthetic", () => {
  assert.throws(
    () =>
      createBackfillPreview({
        sourceSnapshot: {
          sourceKind: "live" as "synthetic",
          sourceVersion: "source-v1",
          rows: sourceRows,
        },
        mapping,
        schemaVersion: "release1-k12-schema-v1",
      }),
    (error: unknown) =>
      error instanceof BackfillPreviewContractError &&
      error.code === "BACKFILL_SOURCE_NOT_SYNTHETIC",
  );
});

test("CLI exposes preview only and writes no source or target side-effect contract", async () => {
  const inputPath = resolve("tests/fixtures/backfill/synthetic-preview.json");

  const result = spawnSync(process.execPath, [resolve("scripts/backfill/preview.ts"), "--input", inputPath], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout) as ReturnType<typeof createBackfillPreview>;
  assert.deepEqual(report.execution, {
    mode: "preview_only",
    sourceWrites: "forbidden",
    targetWrites: "forbidden",
  });
  assert.equal(result.stderr, "");
});
