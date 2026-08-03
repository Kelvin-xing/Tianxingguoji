import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  createOpaqueDocumentObjectKey,
  evaluateDocumentPurge,
  evaluateDocumentRestore,
  evaluateDocumentVersionActivation,
  evaluateDocumentVersionDownload,
  evaluateDocumentVersionTransition,
  type DocumentRecord,
  type DocumentVersionRecord,
} from "../../../modules/documents/contract.ts";
import {
  DocumentObjectStoreAdapter,
  type ObjectStoreSigner,
} from "../../../adapters/object-store.ts";
import { planMigration } from "../../../scripts/db/plan-migration.ts";

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000101";
const DOCUMENT_ID = "20000000-0000-4000-8000-000000000101";
const VERSION_ID = "30000000-0000-4000-8000-000000000101";
const CASE_ID = "40000000-0000-4000-8000-000000000101";
const ACTOR_ID = "50000000-0000-4000-8000-000000000101";
const NOW = "2026-08-02T00:00:00.000Z";

function makeDocument(overrides: Partial<DocumentRecord> = {}): DocumentRecord {
  return {
    id: DOCUMENT_ID,
    organizationId: ORGANIZATION_ID,
    owner: { kind: "case", id: CASE_ID },
    classification: "application_material",
    lifecycleState: "active",
    activeVersionId: null,
    legalHold: false,
    legalHoldReason: null,
    softDeletedAt: null,
    retentionEndsAt: null,
    recordVersion: 1,
    ...overrides,
  };
}

function makeVersion(
  overrides: Partial<DocumentVersionRecord> = {},
): DocumentVersionRecord {
  return {
    id: VERSION_ID,
    organizationId: ORGANIZATION_ID,
    documentId: DOCUMENT_ID,
    object: {
      region: "ap-east-1",
      bucket: "synthetic-document-bucket",
      key: createOpaqueDocumentObjectKey(DOCUMENT_ID, VERSION_ID),
      versionId: "s3-version-1",
    },
    checksumSha256: "a".repeat(64),
    sizeBytes: 1024,
    detectedContentType: "application/pdf",
    uploadedBy: ACTOR_ID,
    state: "available",
    revokedAt: null,
    recordVersion: 1,
    ...overrides,
  };
}

test("creates opaque regional keys and rejects identity-bearing key inputs", () => {
  const key = createOpaqueDocumentObjectKey(DOCUMENT_ID, VERSION_ID);

  assert.equal(
    key,
    `documents/${DOCUMENT_ID}/versions/${VERSION_ID}`,
  );
  assert.throws(
    () => createOpaqueDocumentObjectKey("student-alice", VERSION_ID),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "DOCUMENT_OBJECT_KEY_INVALID",
  );
});

test("allows only a clean available version to become active or downloadable", () => {
  const document = makeDocument();
  const available = makeVersion();

  assert.deepEqual(evaluateDocumentVersionActivation({ document, version: available }), {
    allowed: true,
  });
  assert.deepEqual(evaluateDocumentVersionDownload({ document, version: available }), {
    allowed: true,
  });
  assert.deepEqual(
    evaluateDocumentVersionDownload({
      document,
      version: makeVersion({ state: "scanning" }),
    }),
    { allowed: false, code: "DOCUMENT_VERSION_NOT_AVAILABLE" },
  );
  assert.deepEqual(
    evaluateDocumentVersionActivation({
      document,
      version: makeVersion({ revokedAt: "2026-08-02T00:00:00.000Z" }),
    }),
    { allowed: false, code: "DOCUMENT_VERSION_REVOKED" },
  );
  assert.deepEqual(
    evaluateDocumentVersionActivation({
      document,
      version: makeVersion({
        object: {
          ...available.object,
          key: "documents/student-alice/versions/unsafe",
        },
      }),
    }),
    { allowed: false, code: "DOCUMENT_OBJECT_KEY_INVALID" },
  );
  assert.deepEqual(
    evaluateDocumentVersionDownload({
      document: makeDocument({ lifecycleState: "pending_delete" }),
      version: available,
    }),
    { allowed: false, code: "DOCUMENT_NOT_ACTIVE" },
  );
});

test("requires quarantine, scanning, and an explicit clean verdict for lifecycle progress", () => {
  assert.deepEqual(
    evaluateDocumentVersionTransition({ from: "pending_upload", to: "quarantined" }),
    { allowed: true },
  );
  assert.deepEqual(
    evaluateDocumentVersionTransition({ from: "pending_upload", to: "available" }),
    { allowed: false, code: "DOCUMENT_VERSION_TRANSITION_INVALID" },
  );
  assert.deepEqual(
    evaluateDocumentVersionTransition({ from: "scanning", to: "available" }),
    { allowed: false, code: "DOCUMENT_SCAN_VERDICT_REQUIRED" },
  );
  assert.deepEqual(
    evaluateDocumentVersionTransition({
      from: "scanning",
      to: "available",
      scanVerdict: "clean",
    }),
    { allowed: true },
  );
  assert.deepEqual(
    evaluateDocumentVersionTransition({
      from: "scanning",
      to: "rejected",
      scanVerdict: "malicious",
    }),
    { allowed: true },
  );
});

test("restores only a clean version inside the approved 30-day soft-delete window", () => {
  const document = makeDocument({
    lifecycleState: "pending_delete",
    softDeletedAt: "2026-07-20T00:00:00.000Z",
  });
  const version = makeVersion();

  assert.deepEqual(
    evaluateDocumentRestore({
      document,
      version,
      now: NOW,
      expectedRecordVersion: 1,
    }),
    { allowed: true },
  );
  assert.deepEqual(
    evaluateDocumentRestore({
      document: makeDocument({
        lifecycleState: "pending_delete",
        softDeletedAt: "2026-06-01T00:00:00.000Z",
      }),
      version,
      now: NOW,
      expectedRecordVersion: 1,
    }),
    { allowed: false, code: "DOCUMENT_SOFT_DELETE_WINDOW_EXPIRED" },
  );
  assert.deepEqual(
    evaluateDocumentRestore({
      document,
      version: makeVersion({ state: "quarantined" }),
      now: NOW,
      expectedRecordVersion: 1,
    }),
    { allowed: false, code: "DOCUMENT_RESTORE_REQUIRES_CLEAN_VERSION" },
  );
  assert.deepEqual(
    evaluateDocumentRestore({
      document,
      version,
      now: NOW,
      expectedRecordVersion: 2,
    }),
    { allowed: false, code: "DOCUMENT_STALE_VERSION" },
  );
});

test("fails purge closed for legal hold, references, active window, and unresolved retention", () => {
  const baseInput = {
    document: makeDocument({
      lifecycleState: "pending_delete",
      softDeletedAt: "2026-06-01T00:00:00.000Z",
    }),
    now: NOW,
    expectedRecordVersion: 1,
    hasLiveReferences: false,
    founderApproved: true,
  } as const;

  assert.deepEqual(
    evaluateDocumentPurge({
      ...baseInput,
      document: makeDocument({
        lifecycleState: "pending_delete",
        softDeletedAt: "2026-06-01T00:00:00.000Z",
        legalHold: true,
        legalHoldReason: "synthetic investigation",
        retentionEndsAt: "2026-08-01T00:00:00.000Z",
      }),
    }),
    { allowed: false, code: "DOCUMENT_LEGAL_HOLD" },
  );
  assert.deepEqual(
    evaluateDocumentPurge({
      ...baseInput,
      document: makeDocument({
        lifecycleState: "pending_delete",
        softDeletedAt: "2026-06-01T00:00:00.000Z",
        retentionEndsAt: "2026-08-01T00:00:00.000Z",
      }),
      hasLiveReferences: true,
    }),
    { allowed: false, code: "DOCUMENT_LIVE_REFERENCE" },
  );
  assert.deepEqual(
    evaluateDocumentPurge({
      ...baseInput,
      document: makeDocument({
        lifecycleState: "pending_delete",
        softDeletedAt: "2026-07-20T00:00:00.000Z",
      }),
    }),
    { allowed: false, code: "DOCUMENT_SOFT_DELETE_WINDOW_ACTIVE" },
  );
  assert.deepEqual(evaluateDocumentPurge(baseInput), {
    allowed: false,
    code: "DOCUMENT_RETENTION_POLICY_REQUIRED",
  });
  assert.deepEqual(
    evaluateDocumentPurge({
      ...baseInput,
      document: makeDocument({
        lifecycleState: "pending_delete",
        softDeletedAt: "2026-06-01T00:00:00.000Z",
        retentionEndsAt: "2026-09-01T00:00:00.000Z",
      }),
    }),
    { allowed: false, code: "DOCUMENT_RETENTION_NOT_REACHED" },
  );
  assert.deepEqual(
    evaluateDocumentPurge({
      ...baseInput,
      founderApproved: false,
    }),
    { allowed: false, code: "DOCUMENT_PURGE_REQUIRES_FOUNDER" },
  );
  assert.deepEqual(
    evaluateDocumentPurge({
      ...baseInput,
      document: makeDocument({
        lifecycleState: "pending_delete",
        softDeletedAt: "2026-06-01T00:00:00.000Z",
        retentionEndsAt: "2026-08-01T00:00:00.000Z",
      }),
    }),
    { allowed: true },
  );
});

test("signer adapter binds upload and download intents to the exact HK object", async () => {
  const signer: ObjectStoreSigner = {
    issueUploadIntent: async (input) => ({
      ...input,
      operation: "upload",
      url: "https://s3.ap-east-1.amazonaws.com/synthetic",
    }),
    issueDownloadIntent: async (input) => ({
      ...input,
      operation: "download",
      url: "https://s3.ap-east-1.amazonaws.com/synthetic",
    }),
  };
  const adapter = new DocumentObjectStoreAdapter(signer, {
    region: "ap-east-1",
    bucket: "synthetic-document-bucket",
  });
  const version = makeVersion({ state: "pending_upload" });

  const upload = await adapter.createUploadIntent({
    version,
    now: NOW,
    expiresAt: "2026-08-02T00:10:00.000Z",
  });
  assert.equal(upload.operation, "upload");
  assert.equal(upload.key, version.object.key);
  assert.equal(upload.region, "ap-east-1");
  await assert.rejects(
    () =>
      adapter.createUploadIntent({
        version: makeVersion({
          state: "pending_upload",
          object: {
            ...version.object,
            key: "documents/student-alice/versions/unsafe",
          },
        }),
        now: NOW,
        expiresAt: "2026-08-02T00:10:00.000Z",
      }),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "DOCUMENT_OBJECT_KEY_INVALID",
  );
  await assert.rejects(
    () =>
      adapter.createDownloadIntent({
        document: makeDocument(),
        version,
        now: NOW,
        expiresAt: "2026-08-02T00:10:00.000Z",
      }),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "DOCUMENT_VERSION_NOT_AVAILABLE",
  );
});

test("publishes the document schema and object guards through the migration planner", async () => {
  const migrationPath = resolve("db/migrations/202608022430_006_expand_documents.sql");
  const migration = await readFile(migrationPath, "utf8");
  assert.match(migration, /CREATE TABLE documents_documents/);
  assert.match(migration, /CREATE TABLE documents_document_versions/);
  assert.match(migration, /CREATE TABLE documents_scan_results/);
  assert.match(migration, /documents_documents_active_version_fk/);
  assert.match(migration, /documents_reject_immutable_delete/);
  assert.match(migration, /documents_validate_version_write/);
  assert.match(migration, /documents_validate_document_write/);
  assert.match(migration, /documents_documents_initial_state_check/);
  assert.match(migration, /documents_documents_deleted_immutable_check/);
  assert.match(migration, /documents_documents_soft_deleted_at_immutable_check/);
  assert.match(migration, /documents_documents_retention_ends_at_immutable_check/);
  assert.match(migration, /documents_assert_active_founder/);
  assert.match(migration, /documents_documents_purge_approval_check/);
  assert.match(migration, /documents_document_versions_active_pointer_check/);
  assert.match(migration, /documents_document_versions_revocation_immutable_check/);
  assert.match(
    migration,
    /ON documents_document_versions \(organization_id, object_bucket, object_key, object_version_id\)/,
  );
  assert.match(migration, /ap-east-1/);
  assert.match(migration, /legal_hold/);
  assert.match(migration, /soft_delete/);

  const plan = await planMigration({
    migrationDirectory: resolve("db/migrations"),
    snapshot: {
      target: "empty",
      applied: [],
      expectedSchemaSha256: null,
      actualSchemaSha256: null,
    },
  });
  assert.equal(plan.status, "pass");
  assert.deepEqual(
    plan.migrations.find(({ name }) => name === "202608022430_006_expand_documents.sql"),
    {
      name: "202608022430_006_expand_documents.sql",
      sha256: "5bf8cf047bc9ac10fcad6813a0bfb42431c469c03570e86e237897beb5d09758",
      state: "pending",
    },
  );
});

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

test(
  "applies the additive document schema and exposes tenant, version, scan, and active-pointer constraints",
  { skip: testDatabaseUrl ? false : "TEST_DATABASE_URL is required for PostgreSQL evidence" },
  async () => {
    const { Client } = await import("pg");
    const migrationNames = [
      "202608021330_001_expand_identity_access.sql",
      "202608021630_002_expand_crm.sql",
      "202608021830_003_expand_cases.sql",
      "202608022030_004_expand_school_overlay.sql",
      "202608022230_005_expand_tasks.sql",
      "202608022430_006_expand_documents.sql",
    ];
    const client = new Client({ connectionString: testDatabaseUrl });

    await client.connect();
    try {
      await client.query("BEGIN");
      for (const migrationName of migrationNames) {
        await client.query(
          await readFile(resolve("db/migrations", migrationName), "utf8"),
        );
      }

      const tables = await client.query<{ tablename: string }>(
        `SELECT tablename
           FROM pg_catalog.pg_tables
          WHERE schemaname = 'public'
            AND tablename = ANY($1::text[])
          ORDER BY tablename`,
        [[
          "documents_documents",
          "documents_document_versions",
          "documents_scan_results",
        ]],
      );
      assert.deepEqual(tables.rows.map(({ tablename }) => tablename), [
        "documents_document_versions",
        "documents_documents",
        "documents_scan_results",
      ]);

      const constraints = await client.query<{ conname: string }>(
        `SELECT conname
           FROM pg_catalog.pg_constraint
          WHERE conname = ANY($1::text[])
          ORDER BY conname`,
        [[
          "documents_documents_active_version_fk",
          "documents_documents_case_fk",
          "documents_documents_student_fk",
          "documents_documents_task_fk",
          "documents_document_versions_tenant_key",
          "documents_scan_results_work_key",
        ]],
      );
      assert.deepEqual(constraints.rows.map(({ conname }) => conname), [
        "documents_document_versions_tenant_key",
        "documents_documents_active_version_fk",
        "documents_documents_case_fk",
        "documents_documents_student_fk",
        "documents_documents_task_fk",
        "documents_scan_results_work_key",
      ]);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      await client.end();
    }
  },
);
