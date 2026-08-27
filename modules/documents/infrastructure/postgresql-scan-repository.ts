import "server-only";

import { appendAtomicMutationEffects } from "../../audit/server.ts";
import type { TenantTransaction, TenantTransactionRunner } from "../../shared/server.ts";
import {
  DocumentObjectReceiptError,
  isDocumentObjectReceiptError,
  type DocumentObjectHead,
  type DocumentObjectReceiptRepository,
} from "../application/object-receipt-service.ts";
import {
  DocumentScanError,
  type DocumentScanEvent,
  type DocumentScanReconciliationCandidate,
  type DocumentScanRepository,
  type DocumentScanWork,
} from "../application/scan-service.ts";
import { DOCUMENT_SCAN_POLICY_VERSION } from "../domain/contract.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface ReceiptVersionRow extends Record<string, unknown> {
  id: string;
  document_id: string;
  object_bucket: string;
  object_key: string;
  object_version_id: string | null;
  checksum_sha256: string;
  size_bytes: number | string;
  detected_content_type: string;
  state: string;
  upload_generation: number | string;
}

interface ScanRow extends Record<string, unknown> {
  version_id: string;
  document_id: string;
  object_bucket: string;
  object_key: string;
  object_version_id: string;
  version_state: string;
  upload_generation: number | string;
  scan_id: string;
  scan_state: string;
  attempt_count: number | string;
  scan_policy_version: string;
  started_at: Date | string | null;
  updated_at: Date | string;
}

interface CleanupEffectRow extends Record<string, unknown> {
  aggregate_id: string;
  aggregate_type: string;
  event_type: string;
}

export interface PostgresqlDocumentScanRepositoryOptions {
  readonly organizationId: string;
  readonly workerContextId: string;
  readonly hooks?: Readonly<{
    readonly failBeforeCommit?: (operation: string) => void;
  }>;
}

export class PostgresqlDocumentScanRepository
implements DocumentObjectReceiptRepository, DocumentScanRepository {
  private readonly runner: TenantTransactionRunner;
  private readonly organizationId: string;
  private readonly workerContextId: string;
  private readonly hooks: NonNullable<PostgresqlDocumentScanRepositoryOptions["hooks"]>;

  constructor(runner: TenantTransactionRunner, options: PostgresqlDocumentScanRepositoryOptions) {
    if (!UUID.test(options.organizationId) || !UUID.test(options.workerContextId) ||
        options.organizationId === options.workerContextId) {
      throw new TypeError("Document scan repository requires a non-user worker tenant context.");
    }
    this.runner = runner;
    this.organizationId = options.organizationId;
    this.workerContextId = options.workerContextId;
    this.hooks = options.hooks ?? {};
  }

  receive(input: Parameters<DocumentObjectReceiptRepository["receive"]>[0]) {
    if (input.organizationId !== this.organizationId) {
      return Promise.resolve(Object.freeze({ status: "duplicate" as const }));
    }
    return this.runReceipt(async (transaction) => {
      if (!await lockParentDocument(transaction, input.event, this.organizationId)) {
        return Object.freeze({ status: "duplicate" as const });
      }
      const row = await selectReceiptVersion(transaction, input.event, this.organizationId);
      if (!row) return Object.freeze({ status: "duplicate" as const });
      if (row.state === "abandoned") {
        if (row.object_version_id !== null) receiptUnavailable();
        return Object.freeze({
          status: "abandoned_cleanup" as const,
          documentVersionId: row.id,
        });
      }
      if (row.object_version_id !== null) {
        if (row.object_version_id !== input.event.versionId) {
          return Object.freeze({
            status: "unbound_provider_version_cleanup" as const,
            documentVersionId: row.id,
          });
        }
        if (row.state === "scanning") {
          return Object.freeze({ status: "in_progress" as const });
        }
        if (row.state === "quarantined" || row.state === "scan_failed") {
          if (row.state === "scan_failed" &&
              await newerGenerationExists(transaction, row, this.organizationId)) {
            return Object.freeze({ status: "duplicate" as const });
          }
          return Object.freeze({ status: "ready" as const });
        }
        if (row.state !== "pending_upload") {
          return Object.freeze({ status: "duplicate" as const });
        }
      }
      if (row.state !== "pending_upload") {
        return Object.freeze({ status: "duplicate" as const });
      }

      const matches = integrityMatches(row, await input.loadHead());
      const nextState = matches ? "quarantined" : "rejected";
      const updated = await transaction.query({
        text: `UPDATE documents_document_versions
          SET object_version_id=$4,state=$5,record_version=record_version+1,
              updated_at=transaction_timestamp()
         WHERE id=$1 AND organization_id=$2 AND object_key=$3
           AND (object_version_id IS NULL OR object_version_id=$4)
           AND state='pending_upload'`,
        values: [row.id, this.organizationId, row.object_key, input.event.versionId, nextState],
      });
      if (updated.rowCount !== 1) receiptUnavailable();

      if (matches) {
        const queued = await transaction.query({
          text: `INSERT INTO documents_scan_results
            (id,organization_id,document_version_id,scan_policy_version,state,engine,
             signature,attempt_count,started_at,completed_at,record_version,
             object_bucket,object_key,object_version_id)
           VALUES ($1,$2,$3,$4,'queued',NULL,NULL,0,NULL,NULL,1,$5,$6,$7)`,
          values: [
            input.scanResultId,
            this.organizationId,
            row.id,
            DOCUMENT_SCAN_POLICY_VERSION,
            row.object_bucket,
            row.object_key,
            input.event.versionId,
          ],
        });
        if (queued.rowCount !== 1) receiptUnavailable();
      }

      await appendEffects(
        transaction,
        input.createEffects({ documentVersionId: row.id, status: nextState }),
      );
      this.hooks.failBeforeCommit?.("receipt");
      return Object.freeze({ status: matches ? "ready" as const : "rejected" as const });
    });
  }

  recordAbandonedObjectRemoval(
    input: Parameters<DocumentObjectReceiptRepository["recordAbandonedObjectRemoval"]>[0],
  ) {
    if (input.organizationId !== this.organizationId) receiptUnavailable();
    return this.runReceipt(async (transaction) => {
      if (!await lockParentDocument(transaction, input.event, this.organizationId)) {
        receiptUnavailable();
      }
      const row = await selectReceiptVersion(transaction, input.event, this.organizationId);
      if (!row || row.id !== input.documentVersionId || row.state !== "abandoned" ||
          row.object_version_id !== null) {
        receiptUnavailable();
      }
      const existing = await transaction.query<CleanupEffectRow>({
        text: `SELECT aggregate_id,aggregate_type,event_type
          FROM audit_outbox
         WHERE organization_id=$1 AND idempotency_key=$2
         FOR SHARE`,
        values: [this.organizationId, input.effectIdempotencyKey],
      });
      if (existing.rowCount === 1) {
        const effect = existing.rows[0];
        if (!effect || effect.aggregate_id !== input.documentVersionId ||
            effect.aggregate_type !== "DocumentVersion" ||
            effect.event_type !== "documents.abandoned_object_removed") {
          receiptUnavailable();
        }
        return Object.freeze({ status: "duplicate" as const });
      }
      if (existing.rowCount !== 0) receiptUnavailable();
      await appendEffects(transaction, input.createEffects());
      this.hooks.failBeforeCommit?.("abandoned_cleanup");
      return Object.freeze({ status: "recorded" as const });
    });
  }

  recordUnboundProviderVersionRemoval(
    input: Parameters<DocumentObjectReceiptRepository["recordUnboundProviderVersionRemoval"]>[0],
  ) {
    if (input.organizationId !== this.organizationId) receiptUnavailable();
    return this.runReceipt(async (transaction) => {
      if (!await lockParentDocument(transaction, input.event, this.organizationId)) {
        receiptUnavailable();
      }
      const row = await selectReceiptVersion(transaction, input.event, this.organizationId);
      if (!row || row.id !== input.documentVersionId || row.state === "abandoned" ||
          row.object_version_id === null || row.object_version_id === input.event.versionId) {
        receiptUnavailable();
      }
      const existing = await transaction.query<CleanupEffectRow>({
        text: `SELECT aggregate_id,aggregate_type,event_type
          FROM audit_outbox
         WHERE organization_id=$1 AND idempotency_key=$2
         FOR SHARE`,
        values: [this.organizationId, input.effectIdempotencyKey],
      });
      if (existing.rowCount === 1) {
        const effect = existing.rows[0];
        if (!effect || effect.aggregate_id !== input.documentVersionId ||
            effect.aggregate_type !== "DocumentVersion" ||
            effect.event_type !== "documents.unbound_provider_version_removed") {
          receiptUnavailable();
        }
        return Object.freeze({ status: "duplicate" as const });
      }
      if (existing.rowCount !== 0) receiptUnavailable();
      await appendEffects(transaction, input.createEffects());
      this.hooks.failBeforeCommit?.("unbound_provider_version_cleanup");
      return Object.freeze({ status: "recorded" as const });
    });
  }

  claimScanWork(input: Parameters<DocumentScanRepository["claimScanWork"]>[0]) {
    return this.runScan(async (transaction) => {
      if (!await lockParentDocument(transaction, input.event, this.organizationId)) scanTransition();
      const row = await selectScanWork(transaction, input.event, this.organizationId);
      if (!row) scanTransition();
      if (row.scan_policy_version !== DOCUMENT_SCAN_POLICY_VERSION ||
          row.object_version_id !== input.event.versionId) {
        scanTransition();
      }

      const attemptCount = integer(row.attempt_count);
      if (row.scan_state === "running" || row.scan_state === "clean" ||
          row.scan_state === "rejected" || attemptCount >= input.event.deliveryAttempt) {
        return Object.freeze({
          status: "duplicate" as const,
          workId: row.scan_id,
          terminalState: scanTerminalState(row.scan_state),
          attemptCount,
        });
      }

      const first = row.version_state === "quarantined" && row.scan_state === "queued" &&
        attemptCount === 0;
      const retry = row.version_state === "scan_failed" && row.scan_state === "failed" &&
        input.event.deliveryAttempt > attemptCount && attemptCount < 3 &&
        !await newerGenerationExists(transaction, row, this.organizationId);
      if (!first && !retry) {
        return Object.freeze({
          status: "duplicate" as const,
          workId: row.scan_id,
          terminalState: scanTerminalState(row.scan_state),
          attemptCount,
        });
      }

      const nextAttempt = attemptCount + 1;

      const scanUpdated = await transaction.query({
        text: `UPDATE documents_scan_results
          SET state='running',engine=NULL,signature=NULL,attempt_count=$4,
              started_at=transaction_timestamp(),completed_at=NULL,
              record_version=record_version+1,updated_at=transaction_timestamp()
         WHERE id=$1 AND organization_id=$2 AND document_version_id=$3
           AND scan_policy_version=$5`,
        values: [
          row.scan_id,
          this.organizationId,
          row.version_id,
          nextAttempt,
          DOCUMENT_SCAN_POLICY_VERSION,
        ],
      });
      if (scanUpdated.rowCount !== 1) scanTransition();
      const versionUpdated = await transaction.query({
        text: `UPDATE documents_document_versions
          SET state='scanning',record_version=record_version+1,updated_at=transaction_timestamp()
         WHERE id=$1 AND organization_id=$2 AND state=$3`,
        values: [row.version_id, this.organizationId, row.version_state],
      });
      if (versionUpdated.rowCount !== 1) scanTransition();

      await appendEffects(
        transaction,
        input.createEffects({
          organizationId: this.organizationId,
          documentVersionId: row.version_id,
        }),
      );
      this.hooks.failBeforeCommit?.("claim");
      return Object.freeze({
        status: "claimed" as const,
        work: scanWork(row, nextAttempt, this.organizationId),
      });
    });
  }

  completeScanWork(input: Parameters<DocumentScanRepository["completeScanWork"]>[0]) {
    return this.runScan(async (transaction) => {
      if (!await lockParentDocument(transaction, input.event, this.organizationId)) scanTransition();
      const row = await selectScanWork(transaction, input.event, this.organizationId);
      if (!row || row.version_id !== input.work.documentVersionId ||
          row.scan_id !== input.work.id || row.version_state !== "scanning" ||
          row.scan_state !== "running" || integer(row.attempt_count) !== input.work.attemptCount) {
        scanTransition();
      }
      if (await newerGenerationExists(transaction, row, this.organizationId)) scanTransition();
      const scanState = input.verdict === "clean" ? "clean" : "rejected";
      const versionState = input.verdict === "clean" ? "available" : "rejected";
      const scanUpdated = await transaction.query({
        text: `UPDATE documents_scan_results
          SET state=$4,engine=$6,signature=NULL,
              completed_at=transaction_timestamp(),record_version=record_version+1,
              updated_at=transaction_timestamp()
         WHERE id=$1 AND organization_id=$2 AND document_version_id=$3
           AND state='running' AND scan_policy_version=$5`,
        values: [
          row.scan_id,
          this.organizationId,
          row.version_id,
          scanState,
          DOCUMENT_SCAN_POLICY_VERSION,
          input.scannerEngine ?? "clamav-release1",
        ],
      });
      if (scanUpdated.rowCount !== 1) scanTransition();
      const versionUpdated = await transaction.query({
        text: `UPDATE documents_document_versions
          SET state=$3,record_version=record_version+1,updated_at=transaction_timestamp()
         WHERE id=$1 AND organization_id=$2 AND state='scanning'`,
        values: [row.version_id, this.organizationId, versionState],
      });
      if (versionUpdated.rowCount !== 1) scanTransition();
      if (input.verdict === "clean") {
        const pointer = await transaction.query({
          text: `UPDATE documents_documents
            SET active_document_version_id=$3,record_version=record_version+1,
                updated_at=transaction_timestamp()
           WHERE id=$1 AND organization_id=$2 AND lifecycle_state='active'`,
          values: [row.document_id, this.organizationId, row.version_id],
        });
        if (pointer.rowCount !== 1) scanTransition();
      }
      await appendEffects(transaction, input.effects);
      this.hooks.failBeforeCommit?.("complete");
      return Object.freeze({
        status: versionState,
        workId: row.scan_id,
        documentVersionId: row.version_id,
      });
    });
  }

  failScanWork(input: Parameters<DocumentScanRepository["failScanWork"]>[0]) {
    return this.runScan(async (transaction) => {
      if (!await lockParentDocument(transaction, input.event, this.organizationId)) scanTransition();
      const row = await selectScanWork(transaction, input.event, this.organizationId);
      if (!row || row.version_id !== input.work.documentVersionId || row.scan_id !== input.work.id ||
          row.version_state !== "scanning" || row.scan_state !== "running" ||
          integer(row.attempt_count) !== input.work.attemptCount) {
        scanTransition();
      }
      const scanUpdated = await transaction.query({
        text: `UPDATE documents_scan_results
          SET state='failed',engine=$5,signature=NULL,
              completed_at=transaction_timestamp(),record_version=record_version+1,
              updated_at=transaction_timestamp()
         WHERE id=$1 AND organization_id=$2 AND document_version_id=$3
           AND state='running' AND scan_policy_version=$4`,
        values: [
          row.scan_id,
          this.organizationId,
          row.version_id,
          DOCUMENT_SCAN_POLICY_VERSION,
          input.scannerEngine ?? "clamav-release1",
        ],
      });
      if (scanUpdated.rowCount !== 1) scanTransition();
      const versionUpdated = await transaction.query({
        text: `UPDATE documents_document_versions
          SET state='scan_failed',record_version=record_version+1,
              updated_at=transaction_timestamp()
         WHERE id=$1 AND organization_id=$2 AND state='scanning'`,
        values: [row.version_id, this.organizationId],
      });
      if (versionUpdated.rowCount !== 1) scanTransition();
      await appendEffects(transaction, input.effects);
      this.hooks.failBeforeCommit?.("fail");
      return Object.freeze({
        status: input.work.attemptCount === 3 || input.event.deliveryAttempt === 3
          ? "dead_letter" as const
          : "retry" as const,
        workId: row.scan_id,
        documentVersionId: row.version_id,
        attemptCount: input.work.attemptCount,
      });
    });
  }

  findReconciliationCandidates(
    input: Parameters<DocumentScanRepository["findReconciliationCandidates"]>[0],
  ) {
    return this.runScan(async (transaction) => {
      const result = await transaction.query<ScanRow>({
        text: `SELECT version.id AS version_id,version.document_id,version.object_bucket,
            version.object_key,version.object_version_id,version.state AS version_state,
            version.upload_generation,scan.id AS scan_id,scan.state AS scan_state,
            scan.attempt_count,scan.scan_policy_version,scan.started_at,scan.updated_at
          FROM documents_document_versions AS version
          JOIN documents_scan_results AS scan
            ON scan.document_version_id=version.id
           AND scan.organization_id=version.organization_id
           AND scan.object_bucket=version.object_bucket
           AND scan.object_key=version.object_key
           AND scan.object_version_id=version.object_version_id
         WHERE version.organization_id=$1
           AND scan.scan_policy_version=$2
           AND (
             (version.state='quarantined' AND scan.state='queued'
               AND scan.updated_at < to_timestamp($3 / 1000.0) - ($4::bigint * interval '1 millisecond'))
             OR (version.state='scanning' AND scan.state='running'
               AND scan.updated_at < to_timestamp($3 / 1000.0) - ($4::bigint * interval '1 millisecond'))
           )
         ORDER BY scan.updated_at,scan.id
         LIMIT $5`,
        values: [
          this.organizationId,
          DOCUMENT_SCAN_POLICY_VERSION,
          input.nowMs,
          input.staleAfterMs,
          input.limit,
        ],
      });
      return Object.freeze(rowsToCandidates(result.rows, this.organizationId));
    });
  }

  reconcileScanCandidate(input: Parameters<DocumentScanRepository["reconcileScanCandidate"]>[0]) {
    if (input.candidate.organizationId !== this.organizationId) {
      return Promise.resolve("ignored" as const);
    }
    return this.runScan(async (transaction) => {
      const event: DocumentScanEvent = Object.freeze({
        eventId: `reconcile-${input.candidate.documentVersionId}`,
        requestId: `reconcile-${input.candidate.documentVersionId}`,
        bucket: input.candidate.bucket,
        key: input.candidate.key,
        versionId: input.candidate.versionId,
        scanPolicyVersion: input.candidate.scanPolicyVersion,
        deliveryAttempt: Math.min(input.candidate.attemptCount + 1, 3),
      });
      if (!await lockParentDocument(transaction, event, this.organizationId)) return "ignored";
      const row = await selectScanWork(transaction, event, this.organizationId);
      if (!row || await newerGenerationExists(transaction, row, this.organizationId)) return "ignored";
      if (input.candidate.kind === "missed_event" && row.version_state === "quarantined" &&
          row.scan_state === "queued") {
        if (timestampMs(row.updated_at) !== input.candidate.observedUpdatedAtMs ||
            !input.publishMissedEvent) {
          return "ignored";
        }
        await input.publishMissedEvent();
        const refreshed = await transaction.query({
          text: `UPDATE documents_scan_results
            SET record_version=record_version+1,updated_at=transaction_timestamp()
           WHERE id=$1 AND organization_id=$2 AND state='queued'`,
          values: [row.scan_id, this.organizationId],
        });
        if (refreshed.rowCount !== 1) scanTransition();
        await appendEffects(transaction, input.effects);
        this.hooks.failBeforeCommit?.("reconcile");
        return "requeued";
      }
      if (input.candidate.kind === "stuck_scan" && row.version_state === "scanning" &&
          row.scan_state === "running") {
        if (timestampMs(row.updated_at) !== input.candidate.observedUpdatedAtMs) {
          return "ignored";
        }
        const attempt = integer(row.attempt_count);
        const failedScan = await transaction.query({
          text: `UPDATE documents_scan_results
            SET state='failed',engine='clamav-release1',signature=NULL,
                completed_at=transaction_timestamp(),record_version=record_version+1,
                updated_at=transaction_timestamp()
           WHERE id=$1 AND organization_id=$2 AND state='running'`,
          values: [row.scan_id, this.organizationId],
        });
        if (failedScan.rowCount !== 1) scanTransition();
        const failedVersion = await transaction.query({
          text: `UPDATE documents_document_versions
            SET state='scan_failed',record_version=record_version+1,
                updated_at=transaction_timestamp()
           WHERE id=$1 AND organization_id=$2 AND state='scanning'`,
          values: [row.version_id, this.organizationId],
        });
        if (failedVersion.rowCount !== 1) scanTransition();
        await appendEffects(transaction, input.effects);
        this.hooks.failBeforeCommit?.("reconcile");
        return attempt >= 3 ? "dead_letter" : "requeued";
      }
      return "ignored";
    });
  }

  private async runReceipt<Result>(
    operation: (transaction: TenantTransaction) => Promise<Result>,
  ): Promise<Result> {
    try {
      return await this.runner.run(
        { organizationId: this.organizationId, actorUserId: this.workerContextId },
        async (transaction) => {
          await assertWorkerContext(transaction, this.organizationId, this.workerContextId);
          return operation(transaction);
        },
      );
    } catch (error) {
      if (isDocumentObjectReceiptError(error)) throw error;
      throw new DocumentObjectReceiptError("DOCUMENT_OBJECT_RECEIPT_UNAVAILABLE");
    }
  }

  private async runScan<Result>(
    operation: (transaction: TenantTransaction) => Promise<Result>,
  ): Promise<Result> {
    try {
      return await this.runner.run(
        { organizationId: this.organizationId, actorUserId: this.workerContextId },
        async (transaction) => {
          await assertWorkerContext(transaction, this.organizationId, this.workerContextId);
          return operation(transaction);
        },
      );
    } catch (error) {
      if (error instanceof DocumentScanError) throw error;
      throw new DocumentScanError("DOCUMENT_SCAN_RESULT_INVALID");
    }
  }
}

async function assertWorkerContext(
  transaction: TenantTransaction,
  organizationId: string,
  workerContextId: string,
): Promise<void> {
  const result = await transaction.query({
    text: `SELECT organization.id
      FROM access_organizations AS organization
     WHERE organization.id=$1 AND organization.status='active'
       AND NOT EXISTS (
         SELECT 1 FROM identity_users AS actor WHERE actor.id=$2
       )
       AND NOT EXISTS (
         SELECT 1 FROM access_role_bindings AS binding
          WHERE binding.organization_id=$1 AND binding.user_id=$2
       )
     FOR SHARE OF organization`,
    values: [organizationId, workerContextId],
  });
  if (result.rowCount !== 1) scanTransition();
}

async function selectReceiptVersion(
  transaction: TenantTransaction,
  event: DocumentScanEvent,
  organizationId: string,
): Promise<ReceiptVersionRow | null> {
  const versionId = event.key.split("/").at(-1);
  const result = await transaction.query<ReceiptVersionRow>({
    text: `SELECT id,document_id,object_bucket,object_key,object_version_id,checksum_sha256,
        size_bytes,detected_content_type,state,upload_generation
      FROM documents_document_versions
     WHERE id=$1::uuid AND organization_id=$2 AND object_bucket=$3 AND object_key=$4
     FOR UPDATE`,
    values: [versionId, organizationId, event.bucket, event.key],
  });
  return result.rows[0] ?? null;
}

async function lockParentDocument(
  transaction: TenantTransaction,
  event: DocumentScanEvent,
  organizationId: string,
): Promise<boolean> {
  const documentId = event.key.split("/").at(1);
  if (!documentId || !UUID.test(documentId)) return false;
  const result = await transaction.query({
    text: `SELECT id FROM documents_documents
     WHERE id=$1::uuid AND organization_id=$2
     FOR UPDATE`,
    values: [documentId, organizationId],
  });
  return result.rowCount === 1;
}

async function selectScanWork(
  transaction: TenantTransaction,
  event: DocumentScanEvent,
  organizationId: string,
): Promise<ScanRow | null> {
  const versionId = event.key.split("/").at(-1);
  const result = await transaction.query<ScanRow>({
    text: `SELECT version.id AS version_id,version.document_id,version.object_bucket,
        version.object_key,version.object_version_id,version.state AS version_state,
        version.upload_generation,scan.id AS scan_id,scan.state AS scan_state,
        scan.attempt_count,scan.scan_policy_version,scan.started_at,scan.updated_at
      FROM documents_document_versions AS version
      JOIN documents_scan_results AS scan
        ON scan.document_version_id=version.id
       AND scan.organization_id=version.organization_id
       AND scan.object_bucket=version.object_bucket
       AND scan.object_key=version.object_key
       AND scan.object_version_id=version.object_version_id
     WHERE version.id=$1::uuid AND version.organization_id=$2
       AND version.object_bucket=$3 AND version.object_key=$4
       AND version.object_version_id=$5 AND scan.scan_policy_version=$6
     FOR UPDATE OF version,scan`,
    values: [
      versionId,
      organizationId,
      event.bucket,
      event.key,
      event.versionId,
      event.scanPolicyVersion,
    ],
  });
  return result.rows[0] ?? null;
}

async function newerGenerationExists(
  transaction: TenantTransaction,
  row: Pick<ReceiptVersionRow, "document_id" | "upload_generation">,
  organizationId: string,
): Promise<boolean> {
  const result = await transaction.query({
    text: `SELECT 1 FROM documents_document_versions
     WHERE organization_id=$1 AND document_id=$2 AND upload_generation>$3
     LIMIT 1`,
    values: [organizationId, row.document_id, integer(row.upload_generation)],
  });
  return result.rowCount === 1;
}

function integrityMatches(
  row: ReceiptVersionRow,
  head: DocumentObjectHead,
): boolean {
  return integer(row.size_bytes) === head.sizeBytes &&
    row.detected_content_type === head.contentType &&
    Buffer.from(row.checksum_sha256, "hex").toString("base64") === head.checksumSha256Base64;
}

function scanWork(
  row: ScanRow,
  attemptCount: number,
  organizationId: string,
): DocumentScanWork {
  return Object.freeze({
    id: row.scan_id,
    organizationId,
    documentVersionId: row.version_id,
    bucket: row.object_bucket,
    key: row.object_key,
    versionId: row.object_version_id,
    scanPolicyVersion: row.scan_policy_version,
    attemptCount,
    state: "running" as const,
  });
}

function rowsToCandidates(
  rows: readonly ScanRow[],
  organizationId: string,
): readonly DocumentScanReconciliationCandidate[] {
  return rows.map((row) => Object.freeze({
    kind: row.version_state === "quarantined" ? "missed_event" as const : "stuck_scan" as const,
    organizationId,
    documentVersionId: row.version_id,
    bucket: row.object_bucket,
    key: row.object_key,
    versionId: row.object_version_id,
    scanPolicyVersion: row.scan_policy_version,
    attemptCount: integer(row.attempt_count),
    observedUpdatedAtMs: timestampMs(row.updated_at),
  }));
}

function timestampMs(value: Date | string): number {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) scanTransition();
  return parsed;
}

function scanTerminalState(value: string): "running" | "clean" | "rejected" | "failed" {
  if (value === "running" || value === "clean" || value === "rejected" || value === "failed") {
    return value;
  }
  return "running";
}

async function appendEffects(
  transaction: TenantTransaction,
  effects: Parameters<typeof appendAtomicMutationEffects>[1],
): Promise<void> {
  await appendAtomicMutationEffects(Object.freeze({
    async query<Row extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      values?: readonly unknown[],
    ) {
      const result = await transaction.query<Row>({ text, values });
      return Object.freeze({ rows: result.rows, rowCount: result.rowCount ?? result.rows.length });
    },
  }), effects);
}

function integer(value: number | string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) scanTransition();
  return parsed;
}

function receiptUnavailable(): never {
  throw new DocumentObjectReceiptError("DOCUMENT_OBJECT_RECEIPT_UNAVAILABLE");
}

function scanTransition(): never {
  throw new DocumentScanError("DOCUMENT_SCAN_TRANSITION_INVALID");
}
