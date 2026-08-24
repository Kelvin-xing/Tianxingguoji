import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

import { Client, Pool } from "pg";

import { DocumentObjectReceiptService } from
  "../../modules/documents/application/object-receipt-service.ts";
import { DocumentScanService } from "../../modules/documents/application/scan-service.ts";
import { DOCUMENT_SCAN_POLICY_VERSION } from "../../modules/documents/domain/contract.ts";
import { PostgresqlDocumentScanRepository } from
  "../../modules/documents/infrastructure/postgresql-scan-repository.ts";
import {
  createTenantTransactionRunner,
  type DatabasePool,
} from "../../modules/shared/server.ts";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const ORGANIZATION_ID = "71000000-0000-4000-8000-000000000001";
const FOUNDER_ID = "71000000-0000-4000-8000-000000000101";
const MEMBERSHIP_ID = "71000000-0000-4000-8000-000000000201";
const ROLE_BINDING_ID = "71000000-0000-4000-8000-000000000301";
const STUDENT_ID = "71000000-0000-4000-8000-000000000401";
const GUARDIAN_ID = "71000000-0000-4000-8000-000000000402";
const RELATIONSHIP_ID = "71000000-0000-4000-8000-000000000403";
const WORKER_ID = "71000000-0000-4000-8000-000000000901";
const BUCKET = "tianxing-doc02-upgrade";
const LEGACY_DOCUMENT_ID = "71000000-0000-4000-8000-000000000501";
const LEGACY_DELETED_VERSION_ID = "71000000-0000-4000-8000-000000000601";
const LEGACY_PENDING_VERSION_ID = "71000000-0000-4000-8000-000000000602";
const LEGACY_REJECTED_SCAN_ID = "71000000-0000-4000-8000-000000000701";
const LEGACY_PENDING_SCAN_ID = "71000000-0000-4000-8000-000000000702";
const RETRY_DOCUMENT_ID = "71000000-0000-4000-8000-000000000502";
const RETRY_VERSION_ID = "71000000-0000-4000-8000-000000000603";
const RETRY_NEWER_VERSION_ID = "71000000-0000-4000-8000-000000000604";
const RETRY_SCAN_ID = "71000000-0000-4000-8000-000000000703";
const RECONCILE_DOCUMENT_ID = "71000000-0000-4000-8000-000000000503";
const RECONCILE_VERSION_ID = "71000000-0000-4000-8000-000000000605";
const RECONCILE_SCAN_ID = "71000000-0000-4000-8000-000000000704";
const POINTER_DOCUMENT_ID = "71000000-0000-4000-8000-000000000504";
const POINTER_VERSION_ID = "71000000-0000-4000-8000-000000000606";
const POINTER_SCAN_ID = "71000000-0000-4000-8000-000000000705";
const PURGE_DOCUMENT_ID = "71000000-0000-4000-8000-000000000505";
const ABANDON_WINS_DOCUMENT_ID = "71000000-0000-4000-8000-000000000506";
const ABANDON_WINS_VERSION_ID = "71000000-0000-4000-8000-000000000607";
const RECEIPT_WINS_DOCUMENT_ID = "71000000-0000-4000-8000-000000000507";
const RECEIPT_WINS_VERSION_ID = "71000000-0000-4000-8000-000000000608";
const UNBOUND_DOCUMENT_ID = "71000000-0000-4000-8000-000000000508";
const UNBOUND_VERSION_ID = "71000000-0000-4000-8000-000000000609";
const UNBOUND_SCAN_ID = "71000000-0000-4000-8000-000000000706";

test("migration 035 upgrades populated history and closes concurrent document scan state", {
  skip: DATABASE_URL ? false : "TEST_DATABASE_URL is required for PostgreSQL evidence",
  timeout: 120_000,
}, async () => {
  assert.ok(DATABASE_URL);
  const config = { connectionString: DATABASE_URL } as const;
  const client = new Client(config);
  await client.connect();
  try {
    await installPreDoc02Baseline(client);
    await seedLegacyHistory(client);
    await assertNamedActivePointerPreflight(client);
    await client.query(await readFile(
      "db/migrations/202608240010_035_harden_document_upload_scan_download.sql",
      "utf8",
    ));

    await assertBackfilledHistory(client);
    await assertLegacyBoundReceiptAndAttemptCeiling(client);
    await assertFounderLifecycleGrant(client);
  } finally {
    await client.end();
  }

  await assertNewerGenerationSerializesRetry(config);
  await assertActivePointerConcurrency(config);
  await assertReconciliationOrdering(config);
  await assertAbandonmentReceiptLockOrders(config);
  await assertUnboundProviderVersionCleanup(config);
});

async function installPreDoc02Baseline(client: Client): Promise<void> {
  await client.query(`DO $bootstrap$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tianxing_app') THEN
      CREATE ROLE tianxing_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
        NOINHERIT NOREPLICATION NOBYPASSRLS;
    END IF;
  END
  $bootstrap$`);
  const names = (await readdir("db/baselines/one-role/generated"))
    .filter((name) => /^(?:00[1-9]|0[12][0-9]|03[0-3])_/u.test(name))
    .sort();
  assert.equal(names.length, 33);
  await client.query("BEGIN");
  try {
    for (const name of names) {
      await client.query(await readFile(`db/baselines/one-role/generated/${name}`, "utf8"));
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function seedLegacyHistory(client: Client): Promise<void> {
  await tenantTransaction(client, async () => {
    await client.query(`INSERT INTO identity_users (id,normalized_email,status)
      VALUES ($1,'doc02-upgrade@example.invalid','active')`, [FOUNDER_ID]);
    await client.query(`INSERT INTO access_organizations (id,display_name,status,created_by_user_id)
      VALUES ($1,'DOC02 Upgrade','active',$2)`, [ORGANIZATION_ID, FOUNDER_ID]);
    await client.query(`INSERT INTO access_organization_memberships
      (id,organization_id,user_id,status,created_by_user_id)
      VALUES ($1,$2,$3,'active',$3)`, [MEMBERSHIP_ID, ORGANIZATION_ID, FOUNDER_ID]);
    await client.query(`INSERT INTO access_role_bindings
      (id,organization_id,membership_id,user_id,role,status,created_by_user_id)
      VALUES ($1,$2,$3,$4,'founder','active',$4)`,
    [ROLE_BINDING_ID, ORGANIZATION_ID, MEMBERSHIP_ID, FOUNDER_ID]);
    await client.query(`INSERT INTO crm_students (id,organization_id,display_name,status)
      VALUES ($1,$2,'DOC02 Upgrade Student','active')`, [STUDENT_ID, ORGANIZATION_ID]);
    await client.query(`INSERT INTO crm_guardians (id,organization_id,display_name,status)
      VALUES ($1,$2,'DOC02 Upgrade Guardian','active')`, [GUARDIAN_ID, ORGANIZATION_ID]);
    await client.query(`INSERT INTO crm_student_guardian_relationships
      (id,organization_id,student_id,guardian_id,relationship_type,is_legal_guardian,
       is_primary_contact,is_emergency_contact,is_billing_contact,notification_consent,starts_at)
      VALUES ($1,$2,$3,$4,'other_guardian',true,true,false,false,false,
        transaction_timestamp())`, [RELATIONSHIP_ID, ORGANIZATION_ID, STUDENT_ID, GUARDIAN_ID]);
    await insertDocument(client, LEGACY_DOCUMENT_ID, "Legacy history");

    const deletedCreatedAt = "2030-01-01T00:00:00.000Z";
    const deletedCompletedAt = "2030-01-01T00:00:01.000Z";
    await client.query(`INSERT INTO documents_document_versions
      (id,organization_id,document_id,object_bucket,object_key,object_version_id,
       checksum_sha256,size_bytes,detected_content_type,uploaded_by_user_id,state,
       created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,'legacy-provider-deleted',$6,1024,'application/pdf',$7,
        'pending_upload',$8,$8)`, [
      LEGACY_DELETED_VERSION_ID, ORGANIZATION_ID, LEGACY_DOCUMENT_ID, BUCKET,
      objectKey(LEGACY_DOCUMENT_ID, LEGACY_DELETED_VERSION_ID), "a".repeat(64),
      FOUNDER_ID, deletedCreatedAt,
    ]);
    await client.query(`UPDATE documents_document_versions
      SET state='quarantined',record_version=record_version+1,updated_at=updated_at
      WHERE id=$1`, [LEGACY_DELETED_VERSION_ID]);
    await client.query(`INSERT INTO documents_scan_results
      (id,organization_id,document_version_id,scan_policy_version,state)
      VALUES ($1,$2,$3,$4,'queued')`, [
      LEGACY_REJECTED_SCAN_ID, ORGANIZATION_ID, LEGACY_DELETED_VERSION_ID,
      DOCUMENT_SCAN_POLICY_VERSION,
    ]);
    await client.query(`UPDATE documents_scan_results
      SET state='running',attempt_count=1,started_at=$2,record_version=record_version+1,
          updated_at=$2 WHERE id=$1`, [LEGACY_REJECTED_SCAN_ID, deletedCreatedAt]);
    await client.query(`UPDATE documents_document_versions
      SET state='scanning',record_version=record_version+1,updated_at=updated_at
      WHERE id=$1`, [LEGACY_DELETED_VERSION_ID]);
    await client.query(`UPDATE documents_scan_results
      SET state='rejected',engine='clamav-release1',completed_at=$2,
          record_version=record_version+1,updated_at=$2 WHERE id=$1`,
    [LEGACY_REJECTED_SCAN_ID, deletedCompletedAt]);
    await client.query(`UPDATE documents_document_versions
      SET state='rejected',record_version=record_version+1,updated_at=$2 WHERE id=$1`,
    [LEGACY_DELETED_VERSION_ID, deletedCompletedAt]);
    await client.query(`UPDATE documents_document_versions
      SET state='deleted',record_version=record_version+1,updated_at=updated_at WHERE id=$1`,
    [LEGACY_DELETED_VERSION_ID]);

    const pendingCreatedAt = "2031-01-01T00:00:00.000Z";
    await client.query(`INSERT INTO documents_document_versions
      (id,organization_id,document_id,object_bucket,object_key,object_version_id,
       checksum_sha256,size_bytes,detected_content_type,uploaded_by_user_id,state,
       created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,'legacy-provider-pending',$6,2048,'image/png',$7,
        'pending_upload',$8,$8)`, [
      LEGACY_PENDING_VERSION_ID, ORGANIZATION_ID, LEGACY_DOCUMENT_ID, BUCKET,
      objectKey(LEGACY_DOCUMENT_ID, LEGACY_PENDING_VERSION_ID), "b".repeat(64),
      FOUNDER_ID, pendingCreatedAt,
    ]);
  });
}

async function assertNamedActivePointerPreflight(client: Client): Promise<void> {
  await client.query("ALTER TABLE documents_documents DISABLE TRIGGER documents_documents_write_trg");
  await client.query(`UPDATE documents_documents SET active_document_version_id=$2,
    record_version=record_version+1 WHERE id=$1`, [LEGACY_DOCUMENT_ID, LEGACY_PENDING_VERSION_ID]);
  await client.query("ALTER TABLE documents_documents ENABLE TRIGGER documents_documents_write_trg");
  await client.query("BEGIN");
  try {
    await client.query(await readFile(
      "db/migrations/202608240010_035_harden_document_upload_scan_download.sql",
      "utf8",
    ));
    assert.fail("unsafe active pointer must fail migration 035");
  } catch (error) {
    await client.query("ROLLBACK");
    assertPostgres(error, "23514", "documents_documents_doc02_active_pointer_preflight");
  }
  await client.query("ALTER TABLE documents_documents DISABLE TRIGGER documents_documents_write_trg");
  await client.query(`UPDATE documents_documents SET active_document_version_id=NULL,
    record_version=record_version+1 WHERE id=$1`, [LEGACY_DOCUMENT_ID]);
  await client.query("ALTER TABLE documents_documents ENABLE TRIGGER documents_documents_write_trg");
}

async function assertBackfilledHistory(client: Client): Promise<void> {
  const result = await client.query<{
    id: string;
    upload_generation: string;
    record_version: string;
    updated_at: Date;
  }>(`SELECT id,upload_generation,record_version,updated_at
      FROM documents_document_versions WHERE document_id=$1 ORDER BY upload_generation`,
  [LEGACY_DOCUMENT_ID]);
  assert.deepEqual(result.rows.map((row) => ({
    id: row.id,
    generation: Number(row.upload_generation),
    recordVersion: Number(row.record_version),
    updatedYear: row.updated_at.getUTCFullYear(),
  })), [
    { id: LEGACY_DELETED_VERSION_ID, generation: 1, recordVersion: 6, updatedYear: 2030 },
    { id: LEGACY_PENDING_VERSION_ID, generation: 2, recordVersion: 2, updatedYear: 2031 },
  ]);
}

async function assertLegacyBoundReceiptAndAttemptCeiling(client: Client): Promise<void> {
  await tenantTransaction(client, async () => {
    await client.query(`UPDATE documents_document_versions
      SET state='quarantined',record_version=record_version+1,updated_at=updated_at
      WHERE id=$1 AND object_version_id='legacy-provider-pending'`, [LEGACY_PENDING_VERSION_ID]);
    await client.query(`INSERT INTO documents_scan_results
      (id,organization_id,document_version_id,scan_policy_version,state,attempt_count,
       record_version,object_bucket,object_key,object_version_id)
      VALUES ($1,$2,$3,$4,'queued',0,1,$5,$6,'legacy-provider-pending')`, [
      LEGACY_PENDING_SCAN_ID, ORGANIZATION_ID, LEGACY_PENDING_VERSION_ID,
      DOCUMENT_SCAN_POLICY_VERSION, BUCKET,
      objectKey(LEGACY_DOCUMENT_ID, LEGACY_PENDING_VERSION_ID),
    ]);
  });

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await tenantTransaction(client, async () => {
      await client.query(`UPDATE documents_scan_results
        SET state='running',engine=NULL,signature=NULL,attempt_count=$2,
            started_at=transaction_timestamp(),completed_at=NULL,
            record_version=record_version+1,updated_at=transaction_timestamp()
        WHERE id=$1`, [LEGACY_PENDING_SCAN_ID, attempt]);
      await client.query(`UPDATE documents_document_versions
        SET state='scanning',record_version=record_version+1,updated_at=updated_at WHERE id=$1`,
      [LEGACY_PENDING_VERSION_ID]);
    });
    await tenantTransaction(client, async () => {
      await client.query(`UPDATE documents_scan_results
        SET state='failed',engine='clamav-release1',signature=NULL,
            completed_at=transaction_timestamp(),record_version=record_version+1,
            updated_at=transaction_timestamp() WHERE id=$1`, [LEGACY_PENDING_SCAN_ID]);
      await client.query(`UPDATE documents_document_versions
        SET state='scan_failed',record_version=record_version+1,updated_at=updated_at WHERE id=$1`,
      [LEGACY_PENDING_VERSION_ID]);
    });
  }

  await expectRejected(client, async () => {
    await client.query(`UPDATE documents_scan_results
      SET state='running',engine=NULL,attempt_count=4,started_at=transaction_timestamp(),
          completed_at=NULL,record_version=record_version+1,updated_at=transaction_timestamp()
      WHERE id=$1`, [LEGACY_PENDING_SCAN_ID]);
  }, "23514", "documents_scan_results_attempt_transition_check");
}

async function assertFounderLifecycleGrant(client: Client): Promise<void> {
  await tenantTransaction(client, async () => {
    await insertDocument(client, PURGE_DOCUMENT_ID, "Purge lifecycle");
    await client.query(`UPDATE documents_documents
      SET lifecycle_state='pending_delete',soft_deleted_at=transaction_timestamp()-interval '31 days',
          retention_ends_at=transaction_timestamp()-interval '1 day',
          record_version=record_version+1,updated_at=transaction_timestamp()
      WHERE id=$1`, [PURGE_DOCUMENT_ID]);
    await client.query(`UPDATE documents_documents
      SET lifecycle_state='deleted',purge_approved_by_user_id=$2,
          purge_approved_at=transaction_timestamp(),purge_reason='retention_expired',
          record_version=record_version+1,updated_at=transaction_timestamp()
      WHERE id=$1`, [PURGE_DOCUMENT_ID, FOUNDER_ID]);
  });
  const result = await client.query<{ lifecycle_state: string }>(
    "SELECT lifecycle_state FROM documents_documents WHERE id=$1",
    [PURGE_DOCUMENT_ID],
  );
  assert.equal(result.rows[0]?.lifecycle_state, "deleted");
}

async function assertNewerGenerationSerializesRetry(config: { connectionString: string }) {
  const setup = new Client(config);
  await setup.connect();
  try {
    await tenantTransaction(setup, async () => {
      await insertDocument(setup, RETRY_DOCUMENT_ID, "Retry serialization");
      await insertPendingVersion(setup, RETRY_DOCUMENT_ID, RETRY_VERSION_ID, 1);
      await bindQueued(setup, RETRY_DOCUMENT_ID, RETRY_VERSION_ID, RETRY_SCAN_ID, "retry-v1");
    });
  } finally {
    await setup.end();
  }

  const pool = new Pool({ ...config, max: 2, application_name: "doc02-retry-concurrency" });
  const repository = new PostgresqlDocumentScanRepository(
    createTenantTransactionRunner(pool as unknown as DatabasePool),
    { organizationId: ORGANIZATION_ID, workerContextId: WORKER_ID },
  );
  const service = new DocumentScanService({ repository });
  const event = scanEvent(RETRY_DOCUMENT_ID, RETRY_VERSION_ID, "retry-v1", 1);
  const claim = await service.claimScanWork(event);
  assert.equal(claim.status, "claimed");
  if (claim.status !== "claimed") assert.fail("expected first scan claim");
  await service.failScanWork({ event, work: claim.work });

  const writer = new Client(config);
  await writer.connect();
  await writer.query("BEGIN");
  await setTenant(writer);
  await writer.query("SELECT id FROM documents_documents WHERE id=$1 FOR UPDATE", [RETRY_DOCUMENT_ID]);
  await writer.query(`INSERT INTO documents_document_versions
    (id,organization_id,document_id,object_bucket,object_key,checksum_sha256,size_bytes,
     detected_content_type,uploaded_by_user_id,state,upload_generation)
    VALUES ($1,$2,$3,$4,$5,$6,1024,'application/pdf',$7,'pending_upload',2)`, [
    RETRY_NEWER_VERSION_ID, ORGANIZATION_ID, RETRY_DOCUMENT_ID, BUCKET,
    objectKey(RETRY_DOCUMENT_ID, RETRY_NEWER_VERSION_ID), "d".repeat(64), FOUNDER_ID,
  ]);
  await writer.query(`UPDATE documents_document_versions
    SET object_version_id='retry-v2',state='rejected',record_version=record_version+1,
        updated_at=transaction_timestamp() WHERE id=$1`, [RETRY_NEWER_VERSION_ID]);

  const retryPromise = service.claimScanWork(scanEvent(
    RETRY_DOCUMENT_ID,
    RETRY_VERSION_ID,
    "retry-v1",
    2,
  ));
  await waitForBlockedSession(config, "doc02-retry-concurrency");
  await writer.query("COMMIT");
  await writer.end();
  const retry = await retryPromise;
  assert.equal(retry.status, "duplicate");
  const state = await oneValue(config, "SELECT state FROM documents_document_versions WHERE id=$1", [
    RETRY_VERSION_ID,
  ]);
  assert.equal(state, "scan_failed");
  await pool.end();
}

async function assertActivePointerConcurrency(config: { connectionString: string }) {
  const setup = new Client(config);
  await setup.connect();
  try {
    await tenantTransaction(setup, async () => {
      await insertDocument(setup, POINTER_DOCUMENT_ID, "Pointer serialization");
      await insertPendingVersion(setup, POINTER_DOCUMENT_ID, POINTER_VERSION_ID, 1);
      await bindQueued(setup, POINTER_DOCUMENT_ID, POINTER_VERSION_ID, POINTER_SCAN_ID, "pointer-v1");
    });
    await tenantTransaction(setup, async () => {
      await startScan(setup, POINTER_VERSION_ID, POINTER_SCAN_ID, 1);
    });
    await tenantTransaction(setup, async () => {
      await setup.query(`UPDATE documents_scan_results SET state='clean',engine='clamav-release1',
        completed_at=transaction_timestamp(),record_version=record_version+1,
        updated_at=transaction_timestamp() WHERE id=$1`, [POINTER_SCAN_ID]);
      await setup.query(`UPDATE documents_document_versions SET state='available',
        record_version=record_version+1,updated_at=transaction_timestamp() WHERE id=$1`,
      [POINTER_VERSION_ID]);
    });
  } finally {
    await setup.end();
  }

  const pointer = new Client(config);
  const terminal = new Client(config);
  await Promise.all([pointer.connect(), terminal.connect()]);
  await pointer.query("BEGIN");
  await terminal.query("BEGIN");
  await Promise.all([setTenant(pointer), setTenant(terminal)]);
  await pointer.query(`UPDATE documents_documents SET active_document_version_id=$2,
    record_version=record_version+1,updated_at=transaction_timestamp() WHERE id=$1`,
  [POINTER_DOCUMENT_ID, POINTER_VERSION_ID]);
  await terminal.query(`UPDATE documents_document_versions SET state='superseded',
    record_version=record_version+1,updated_at=transaction_timestamp() WHERE id=$1`,
  [POINTER_VERSION_ID]);
  const commits = await Promise.allSettled([pointer.query("COMMIT"), terminal.query("COMMIT")]);
  await Promise.all([
    pointer.query("ROLLBACK").catch(() => undefined),
    terminal.query("ROLLBACK").catch(() => undefined),
  ]);
  await Promise.all([pointer.end(), terminal.end()]);
  assert.ok(commits.some(({ status }) => status === "rejected"));

  const verify = new Client(config);
  await verify.connect();
  try {
    await verify.query("BEGIN");
    await setTenant(verify);
    const result = await verify.query<{ active_id: string | null; state: string }>(
      `SELECT document.active_document_version_id AS active_id,version.state
         FROM documents_documents AS document
         JOIN documents_document_versions AS version ON version.id=$2
        WHERE document.id=$1`,
      [POINTER_DOCUMENT_ID, POINTER_VERSION_ID],
    );
    const row = result.rows[0];
    assert.ok(row);
    assert.equal(row.active_id === POINTER_VERSION_ID, row.state === "available");
    await verify.query("COMMIT");
  } finally {
    await verify.end();
  }
}

async function assertReconciliationOrdering(config: { connectionString: string }) {
  const setup = new Client(config);
  await setup.connect();
  try {
    await tenantTransaction(setup, async () => {
      await insertDocument(setup, RECONCILE_DOCUMENT_ID, "Reconciliation ordering");
      await insertPendingVersion(setup, RECONCILE_DOCUMENT_ID, RECONCILE_VERSION_ID, 1);
      await bindQueued(
        setup,
        RECONCILE_DOCUMENT_ID,
        RECONCILE_VERSION_ID,
        RECONCILE_SCAN_ID,
        "reconcile-v1",
        120_000,
      );
    });
  } finally {
    await setup.end();
  }

  const pool = new Pool({ ...config, max: 3, application_name: "doc02-reconcile-concurrency" });
  const repository = new PostgresqlDocumentScanRepository(
    createTenantTransactionRunner(pool as unknown as DatabasePool),
    { organizationId: ORGANIZATION_ID, workerContextId: WORKER_ID },
  );
  const nowMs = Date.now();
  const failed = new DocumentScanService({
    repository,
    clock: { nowMs: () => nowMs },
    requeuePublisher: { publish: async () => { throw new Error("synthetic publish failure"); } },
  });
  await assert.rejects(
    () => failed.reconcileDocumentScans({ staleAfterMs: 90_000, limit: 10 }),
    /DOCUMENT_SCAN_RESULT_INVALID/u,
  );
  assert.deepEqual(await reconciliationCounts(config), { scanVersion: 1, audits: 0, outbox: 0 });

  let releasePublish!: () => void;
  let publishStarted!: () => void;
  const started = new Promise<void>((resolve) => { publishStarted = resolve; });
  const release = new Promise<void>((resolve) => { releasePublish = resolve; });
  let publishes = 0;
  const service = new DocumentScanService({
    repository,
    clock: { nowMs: () => nowMs },
    requeuePublisher: {
      publish: async () => {
        publishes += 1;
        publishStarted();
        await release;
      },
    },
  });
  const first = service.reconcileDocumentScans({ staleAfterMs: 90_000, limit: 10 });
  await started;
  const second = service.reconcileDocumentScans({ staleAfterMs: 90_000, limit: 10 });
  await waitForBlockedSession(config, "doc02-reconcile-concurrency");
  releasePublish();
  const outcomes = await Promise.all([first, second]);
  assert.deepEqual(outcomes.map(({ requeued, ignored }) => ({ requeued, ignored })).sort(
    (left, right) => left.ignored - right.ignored,
  ), [{ requeued: 1, ignored: 0 }, { requeued: 0, ignored: 1 }]);
  assert.equal(publishes, 1);
  assert.deepEqual(await reconciliationCounts(config), { scanVersion: 2, audits: 1, outbox: 1 });
  await pool.end();
}

async function assertAbandonmentReceiptLockOrders(config: { connectionString: string }) {
  const setup = new Client(config);
  await setup.connect();
  try {
    await tenantTransaction(setup, async () => {
      await insertDocument(setup, ABANDON_WINS_DOCUMENT_ID, "Abandon wins receipt lock");
      await insertPendingVersion(setup, ABANDON_WINS_DOCUMENT_ID, ABANDON_WINS_VERSION_ID, 1);
      await insertDocument(setup, RECEIPT_WINS_DOCUMENT_ID, "Receipt wins abandon lock");
      await insertPendingVersion(setup, RECEIPT_WINS_DOCUMENT_ID, RECEIPT_WINS_VERSION_ID, 1);
    });
  } finally {
    await setup.end();
  }

  const abandon = new Client({ ...config, application_name: "doc02-abandon-wins" });
  await abandon.connect();
  await abandon.query("BEGIN");
  await setTenant(abandon);
  await abandon.query("SELECT id FROM documents_documents WHERE id=$1 FOR UPDATE", [
    ABANDON_WINS_DOCUMENT_ID,
  ]);
  await abandon.query("SELECT id FROM documents_document_versions WHERE id=$1 FOR UPDATE", [
    ABANDON_WINS_VERSION_ID,
  ]);
  await abandon.query(`UPDATE documents_document_versions
    SET state='abandoned',record_version=record_version+1,updated_at=transaction_timestamp()
    WHERE id=$1 AND state='pending_upload' AND object_version_id IS NULL`, [ABANDON_WINS_VERSION_ID]);
  await abandon.query(`UPDATE documents_documents SET record_version=record_version+1,
    updated_at=transaction_timestamp() WHERE id=$1`, [ABANDON_WINS_DOCUMENT_ID]);

  const cleanupPool = new Pool({ ...config, max: 1, application_name: "doc02-cleanup-after-abandon" });
  let headCalls = 0;
  const cleanupPromise = objectReceiptService(cleanupPool, 710).receive(
    scanEvent(ABANDON_WINS_DOCUMENT_ID, ABANDON_WINS_VERSION_ID, "late-provider-v1", 1),
    async () => {
      headCalls += 1;
      return matchingHead();
    },
  );
  await waitForBlockedSession(config, "doc02-cleanup-after-abandon");
  await abandon.query("COMMIT");
  await abandon.end();
  assert.deepEqual(await cleanupPromise, {
    status: "abandoned_cleanup",
    documentVersionId: ABANDON_WINS_VERSION_ID,
  });
  assert.equal(headCalls, 0);
  await cleanupPool.end();

  let releaseHead!: () => void;
  let markHeadStarted!: () => void;
  const headStarted = new Promise<void>((resolve) => { markHeadStarted = resolve; });
  const headRelease = new Promise<void>((resolve) => { releaseHead = resolve; });
  const receiptPool = new Pool({ ...config, max: 1, application_name: "doc02-receipt-wins" });
  const receiptPromise = objectReceiptService(receiptPool, 720).receive(
    scanEvent(RECEIPT_WINS_DOCUMENT_ID, RECEIPT_WINS_VERSION_ID, "receipt-provider-v1", 1),
    async () => {
      markHeadStarted();
      await headRelease;
      return matchingHead();
    },
  );
  await headStarted;

  const losingAbandon = new Client({ ...config, application_name: "doc02-losing-abandon" });
  await losingAbandon.connect();
  await losingAbandon.query("BEGIN");
  await setTenant(losingAbandon);
  const losingLock = losingAbandon.query(
    "SELECT id FROM documents_documents WHERE id=$1 FOR UPDATE",
    [RECEIPT_WINS_DOCUMENT_ID],
  );
  await waitForBlockedSession(config, "doc02-losing-abandon");
  releaseHead();
  assert.equal((await receiptPromise).status, "ready");
  await losingLock;
  const losingUpdate = await losingAbandon.query(`UPDATE documents_document_versions
    SET state='abandoned',record_version=record_version+1,updated_at=transaction_timestamp()
    WHERE id=$1 AND state='pending_upload' AND object_version_id IS NULL`, [RECEIPT_WINS_VERSION_ID]);
  assert.equal(losingUpdate.rowCount, 0);
  await losingAbandon.query("ROLLBACK");
  await losingAbandon.end();
  await receiptPool.end();

  const verify = new Client(config);
  await verify.connect();
  try {
    await verify.query("BEGIN");
    await setTenant(verify);
    const states = await verify.query<{ id: string; state: string; scans: string }>(`SELECT
      version.id,version.state,
      (SELECT count(*)::text FROM documents_scan_results AS scan
        WHERE scan.organization_id=version.organization_id
          AND scan.document_version_id=version.id) AS scans
      FROM documents_document_versions AS version
      WHERE version.id=ANY($1::uuid[]) ORDER BY version.id`, [[
        ABANDON_WINS_VERSION_ID,
        RECEIPT_WINS_VERSION_ID,
      ]]);
    assert.deepEqual(states.rows.map((row) => ({ id: row.id, state: row.state, scans: Number(row.scans) })), [
      { id: ABANDON_WINS_VERSION_ID, state: "abandoned", scans: 0 },
      { id: RECEIPT_WINS_VERSION_ID, state: "quarantined", scans: 1 },
    ]);
    await verify.query("COMMIT");
    await expectRejected(verify, async () => {
      await verify.query(`UPDATE documents_document_versions SET record_version=record_version+1,
        updated_at=transaction_timestamp() WHERE id=$1`, [ABANDON_WINS_VERSION_ID]);
    }, "23514", "documents_document_versions_abandoned_immutable_check");
  } finally {
    await verify.end();
  }
}

async function assertUnboundProviderVersionCleanup(config: { connectionString: string }) {
  const setup = new Client(config);
  await setup.connect();
  try {
    await tenantTransaction(setup, async () => {
      await insertDocument(setup, UNBOUND_DOCUMENT_ID, "Unbound provider cleanup");
      await insertPendingVersion(setup, UNBOUND_DOCUMENT_ID, UNBOUND_VERSION_ID, 1);
      await bindQueued(
        setup,
        UNBOUND_DOCUMENT_ID,
        UNBOUND_VERSION_ID,
        UNBOUND_SCAN_ID,
        "bound-provider-v1",
      );
    });
  } finally {
    await setup.end();
  }

  const pool = new Pool({ ...config, max: 2, application_name: "doc02-unbound-cleanup" });
  const service = objectReceiptService(pool, 760);
  const unboundEvent = scanEvent(
    UNBOUND_DOCUMENT_ID,
    UNBOUND_VERSION_ID,
    "unbound-provider-v2",
    2,
  );
  let headCalls = 0;
  assert.deepEqual(await service.receive(unboundEvent, async () => {
    headCalls += 1;
    return matchingHead();
  }), {
    status: "unbound_provider_version_cleanup",
    documentVersionId: UNBOUND_VERSION_ID,
  });
  assert.equal(headCalls, 0);

  const sameProvider = await Promise.all([
    service.recordUnboundProviderVersionRemoval(unboundEvent, UNBOUND_VERSION_ID),
    service.recordUnboundProviderVersionRemoval(unboundEvent, UNBOUND_VERSION_ID),
  ]);
  assert.deepEqual(
    sameProvider.map(({ status }) => status).sort(),
    ["duplicate", "recorded"],
  );
  const secondProviderEvent = Object.freeze({
    ...unboundEvent,
    eventId: "doc02-event-unbound-2",
    requestId: "doc02-request-unbound-2",
    versionId: "unbound-provider-v3",
  });
  assert.deepEqual(
    await service.recordUnboundProviderVersionRemoval(secondProviderEvent, UNBOUND_VERSION_ID),
    { status: "recorded" },
  );
  assert.deepEqual(
    await service.recordUnboundProviderVersionRemoval(secondProviderEvent, UNBOUND_VERSION_ID),
    { status: "duplicate" },
  );

  const verify = new Client(config);
  await verify.connect();
  try {
    await verify.query("BEGIN");
    await setTenant(verify);
    const result = await verify.query<{
      bound_provider: string;
      version_state: string;
      scan_count: string;
      audit_count: string;
      outbox_count: string;
    }>(`SELECT
      version.object_version_id AS bound_provider,
      version.state AS version_state,
      (SELECT count(*)::text FROM documents_scan_results AS scan
        WHERE scan.organization_id=version.organization_id
          AND scan.document_version_id=version.id) AS scan_count,
      (SELECT count(*)::text FROM audit_events AS audit
        WHERE audit.organization_id=version.organization_id
          AND audit.resource_id=version.id
          AND audit.event_type='documents.unbound_provider_version_removed') AS audit_count,
      (SELECT count(*)::text FROM audit_outbox AS outbox
        WHERE outbox.organization_id=version.organization_id
          AND outbox.aggregate_id=version.id
          AND outbox.event_type='documents.unbound_provider_version_removed') AS outbox_count
      FROM documents_document_versions AS version
      WHERE version.id=$1`, [UNBOUND_VERSION_ID]);
    const row = result.rows[0];
    assert.ok(row);
    assert.deepEqual({
      bound_provider: row.bound_provider,
      version_state: row.version_state,
      scan_count: Number(row.scan_count),
      audit_count: Number(row.audit_count),
      outbox_count: Number(row.outbox_count),
    }, {
      bound_provider: "bound-provider-v1",
      version_state: "quarantined",
      scan_count: 1,
      audit_count: 2,
      outbox_count: 2,
    });
    await verify.query("COMMIT");
  } finally {
    await verify.end();
    await pool.end();
  }
}

function objectReceiptService(pool: Pool, suffix: number): DocumentObjectReceiptService {
  const repository = new PostgresqlDocumentScanRepository(
    createTenantTransactionRunner(pool as unknown as DatabasePool),
    { organizationId: ORGANIZATION_ID, workerContextId: WORKER_ID },
  );
  let next = suffix;
  return new DocumentObjectReceiptService({
    repository,
    organizationId: ORGANIZATION_ID,
    createId: () => `71000000-0000-4000-8000-${String(next++).padStart(12, "0")}`,
    now: () => Date.now(),
    headTimeoutMs: 5_000,
  });
}

function matchingHead() {
  return Object.freeze({
    sizeBytes: 1024,
    contentType: "application/pdf",
    checksumSha256Base64: Buffer.from("c".repeat(64), "hex").toString("base64"),
  });
}

async function insertDocument(client: Client, id: string, displayName: string) {
  await client.query(`INSERT INTO documents_documents
    (id,organization_id,owner_kind,student_id,display_name,classification,lifecycle_state,
     legal_hold)
    VALUES ($1,$2,'student',$3,$4,'identity_and_case_evidence','active',false)`,
  [id, ORGANIZATION_ID, STUDENT_ID, displayName]);
}

async function insertPendingVersion(
  client: Client,
  documentId: string,
  versionId: string,
  generation: number,
) {
  await client.query(`INSERT INTO documents_document_versions
    (id,organization_id,document_id,object_bucket,object_key,checksum_sha256,size_bytes,
     detected_content_type,uploaded_by_user_id,state,upload_generation)
    VALUES ($1,$2,$3,$4,$5,$6,1024,'application/pdf',$7,'pending_upload',$8)`, [
    versionId, ORGANIZATION_ID, documentId, BUCKET, objectKey(documentId, versionId),
    "c".repeat(64), FOUNDER_ID, generation,
  ]);
}

async function bindQueued(
  client: Client,
  documentId: string,
  versionId: string,
  scanId: string,
  providerVersion: string,
  ageMs = 0,
) {
  await client.query(`UPDATE documents_document_versions
    SET object_version_id=$2,state='quarantined',record_version=record_version+1,
        updated_at=transaction_timestamp() WHERE id=$1`, [versionId, providerVersion]);
  await client.query(`INSERT INTO documents_scan_results
    (id,organization_id,document_version_id,scan_policy_version,state,attempt_count,
     record_version,object_bucket,object_key,object_version_id,created_at,updated_at)
    VALUES ($1,$2,$3,$4,'queued',0,1,$5,$6,$7,
      transaction_timestamp()-($8::bigint * interval '1 millisecond'),
      transaction_timestamp()-($8::bigint * interval '1 millisecond'))`, [
    scanId, ORGANIZATION_ID, versionId, DOCUMENT_SCAN_POLICY_VERSION, BUCKET,
    objectKey(documentId, versionId), providerVersion, ageMs,
  ]);
}

async function startScan(client: Client, versionId: string, scanId: string, attempt: number) {
  await client.query(`UPDATE documents_scan_results
    SET state='running',attempt_count=$2,started_at=transaction_timestamp(),
        record_version=record_version+1,updated_at=transaction_timestamp() WHERE id=$1`,
  [scanId, attempt]);
  await client.query(`UPDATE documents_document_versions SET state='scanning',
    record_version=record_version+1,updated_at=transaction_timestamp() WHERE id=$1`, [versionId]);
}

async function tenantTransaction(client: Client, operation: () => Promise<void>): Promise<void> {
  await client.query("BEGIN");
  try {
    await setTenant(client);
    await operation();
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function setTenant(client: Client): Promise<void> {
  await client.query("SELECT set_config('app.organization_id',$1,true)", [ORGANIZATION_ID]);
  await client.query("SELECT set_config('app.actor_user_id',$1,true)", [FOUNDER_ID]);
}

async function expectRejected(
  client: Client,
  operation: () => Promise<void>,
  code: string,
  constraint: string,
) {
  await client.query("BEGIN");
  await setTenant(client);
  try {
    await operation();
    await client.query("COMMIT");
    assert.fail("expected PostgreSQL rejection");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    assertPostgres(error, code, constraint);
  }
}

async function waitForBlockedSession(
  config: { connectionString: string },
  applicationName: string,
): Promise<void> {
  const monitor = new Client(config);
  await monitor.connect();
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const result = await monitor.query<{ count: string }>(`SELECT count(*)::text AS count
        FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'`,
      [applicationName]);
      if (Number(result.rows[0]?.count ?? 0) >= 1) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } finally {
    await monitor.end();
  }
  assert.fail("expected one blocked PostgreSQL transaction");
}

async function oneValue(
  config: { connectionString: string },
  sql: string,
  values: readonly unknown[],
): Promise<unknown> {
  const client = new Client(config);
  await client.connect();
  try {
    await client.query("BEGIN");
    await setTenant(client);
    const result = await client.query(sql, [...values]);
    await client.query("COMMIT");
    return (result.rows[0] as Record<string, unknown> | undefined)?.state;
  } finally {
    await client.end();
  }
}

async function reconciliationCounts(config: { connectionString: string }) {
  const client = new Client(config);
  await client.connect();
  try {
    await client.query("BEGIN");
    await setTenant(client);
    const result = await client.query<{
      scan_version: string;
      audits: string;
      outbox: string;
    }>(`SELECT
      (SELECT record_version::text FROM documents_scan_results WHERE id=$1) AS scan_version,
      (SELECT count(*)::text FROM audit_events WHERE organization_id=$2
        AND resource_id=$3) AS audits,
      (SELECT count(*)::text FROM audit_outbox WHERE organization_id=$2
        AND aggregate_id=$3) AS outbox`,
    [RECONCILE_SCAN_ID, ORGANIZATION_ID, RECONCILE_VERSION_ID]);
    await client.query("COMMIT");
    return {
      scanVersion: Number(result.rows[0]?.scan_version),
      audits: Number(result.rows[0]?.audits),
      outbox: Number(result.rows[0]?.outbox),
    };
  } finally {
    await client.end();
  }
}

function scanEvent(
  documentId: string,
  versionId: string,
  providerVersion: string,
  deliveryAttempt: number,
) {
  return Object.freeze({
    eventId: `doc02-event-${deliveryAttempt}`,
    requestId: `doc02-request-${deliveryAttempt}`,
    bucket: BUCKET,
    key: objectKey(documentId, versionId),
    versionId: providerVersion,
    scanPolicyVersion: DOCUMENT_SCAN_POLICY_VERSION,
    deliveryAttempt,
  });
}

function objectKey(documentId: string, versionId: string): string {
  return `documents/${documentId}/versions/${versionId}`;
}

function assertPostgres(error: unknown, code: string, constraint: string): void {
  const postgres = error as { readonly code?: unknown; readonly constraint?: unknown };
  assert.equal(postgres.code, code);
  assert.equal(postgres.constraint, constraint);
}
