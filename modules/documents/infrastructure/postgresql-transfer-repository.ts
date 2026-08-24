import "server-only";

import { appendAtomicMutationEffects } from "../../audit/server.ts";
import { hashRequestPayload } from "../../shared/public.ts";
import type { TenantTransaction, TenantTransactionRunner } from "../../shared/server.ts";
import {
  DocumentTransferError,
  isDocumentTransferError,
  isDocumentUploadContentType,
  type DocumentDownloadAuthority,
  type DocumentPendingUploadAuthority,
  type DocumentTransferActorContext,
  type DocumentTransferRepository,
  type DocumentVersionAcknowledgement,
} from "../application/transfer-service.ts";

const CREATE_OPERATION = "documents.create_case_version";
const ABANDON_OPERATION = "documents.abandon_pending_upload";
const REFERENCE = /^([0-9a-f-]{36}):(\d{1,16})$/i;

interface ActorRow extends Record<string, unknown> {
  role: string;
}

interface CaseRow extends Record<string, unknown> {
  id: string;
  stage: string;
  student_status: string;
}

interface DocumentRow extends Record<string, unknown> {
  id: string;
  lifecycle_state: string;
  record_version: number | string;
  active_document_version_id: string | null;
}

interface VersionRow extends Record<string, unknown> {
  id: string;
  document_id: string;
  record_version: number | string;
  detected_content_type: string;
  checksum_sha256: string;
  object_bucket: string;
  object_key: string;
  object_version_id: string | null;
  state: string;
  revoked_at: Date | string | null;
  upload_generation: number | string;
}

interface ReceiptRow extends Record<string, unknown> {
  request_hash: string;
  state: string;
  result_reference: string | null;
  response_hash: string | null;
}

export interface DocumentTransferRepositoryTestHooks {
  readonly failBeforeCommit?: (
    operation: "create" | "abandon" | "upload_intent" | "download_intent",
  ) => void;
}

export class PostgresqlDocumentTransferRepository implements DocumentTransferRepository {
  private readonly runner: TenantTransactionRunner;
  private readonly hooks: DocumentTransferRepositoryTestHooks;

  constructor(
    runner: TenantTransactionRunner,
    hooks: DocumentTransferRepositoryTestHooks = {},
  ) {
    this.runner = runner;
    this.hooks = hooks;
  }

  createVersion(input: Parameters<DocumentTransferRepository["createVersion"]>[0]) {
    return this.run(input, async (transaction) => {
      const replay = await claimReceipt(transaction, input, CREATE_OPERATION);
      await assertActor(transaction, input);
      const serviceCase = await selectVisibleCase(transaction, input, input.caseId, true);
      if (!serviceCase) notFound();
      const document = await selectDocument(transaction, input, input.caseId, input.documentId, true);
      if (!document) notFound();
      if (replay) return replay;
      if (serviceCase.stage === "closed" || serviceCase.student_status !== "active" ||
          document.lifecycle_state !== "active") {
        conflict();
      }
      if (version(document.record_version) !== input.expectedDocumentRecordVersion) stale();
      const uploadGeneration = await nextUploadGeneration(
        transaction,
        input.organizationId,
        input.documentId,
      );

      try {
        const inserted = await transaction.query({
          text: `INSERT INTO documents_document_versions
            (id,organization_id,document_id,object_storage_region,object_bucket,object_key,
             object_version_id,checksum_sha256,size_bytes,detected_content_type,
             uploaded_by_user_id,state,revoked_at,revoke_reason,record_version,upload_generation)
           VALUES ($1,$2,$3,'ap-east-1',$4,$5,NULL,$6,$7,$8,$9,'pending_upload',NULL,NULL,1,$10)`,
          values: [
            input.versionId,
            input.organizationId,
            input.documentId,
            input.bucket,
            input.key,
            input.checksumSha256,
            input.sizeBytes,
            input.contentType,
            input.actorUserId,
            uploadGeneration,
          ],
        });
        if (inserted.rowCount !== 1) unavailable();
      } catch (error) {
        if (postgresCode(error) === "23505") conflict();
        throw error;
      }

      const bumped = await transaction.query({
        text: `UPDATE documents_documents
          SET record_version=record_version+1,updated_at=transaction_timestamp()
         WHERE id=$1 AND organization_id=$2 AND service_case_id=$3
           AND lifecycle_state='active' AND record_version=$4`,
        values: [
          input.documentId,
          input.organizationId,
          input.caseId,
          input.expectedDocumentRecordVersion,
        ],
      });
      if (bumped.rowCount !== 1) stale();

      const result = Object.freeze({ id: input.versionId, recordVersion: 1 });
      await appendEffects(transaction, input.effects);
      this.hooks.failBeforeCommit?.("create");
      await completeReceipt(transaction, input, CREATE_OPERATION, result);
      return result;
    });
  }

  abandonPendingUpload(
    input: Parameters<DocumentTransferRepository["abandonPendingUpload"]>[0],
  ) {
    return this.run(input, async (transaction) => {
      const replay = await claimReceipt(transaction, input, ABANDON_OPERATION);
      await assertActor(transaction, input);
      const serviceCase = await selectVisibleCase(transaction, input, input.caseId, true);
      if (!serviceCase) notFound();
      const document = await selectDocument(transaction, input, input.caseId, input.documentId, true);
      if (!document) notFound();
      const row = await selectVersion(
        transaction,
        input,
        input.documentId,
        input.versionId,
        true,
      );
      if (!row) notFound();
      if (replay) return replay;
      if (serviceCase.stage === "closed" || serviceCase.student_status !== "active" ||
          document.lifecycle_state !== "active") {
        conflict();
      }
      if (row.state !== "pending_upload" || row.object_version_id !== null) conflict();
      if (version(document.record_version) !== input.expectedDocumentRecordVersion ||
          version(row.record_version) !== input.expectedVersionRecordVersion) {
        stale();
      }
      if (!await isLatestUploadGeneration(
        transaction,
        input.organizationId,
        input.documentId,
        row.upload_generation,
      )) {
        conflict();
      }

      const versionUpdated = await transaction.query({
        text: `UPDATE documents_document_versions
          SET state='abandoned',record_version=record_version+1,
              updated_at=transaction_timestamp()
         WHERE id=$1 AND organization_id=$2 AND document_id=$3
           AND state='pending_upload' AND object_version_id IS NULL AND record_version=$4`,
        values: [
          input.versionId,
          input.organizationId,
          input.documentId,
          input.expectedVersionRecordVersion,
        ],
      });
      if (versionUpdated.rowCount !== 1) stale();
      const documentUpdated = await transaction.query({
        text: `UPDATE documents_documents
          SET record_version=record_version+1,updated_at=transaction_timestamp()
         WHERE id=$1 AND organization_id=$2 AND service_case_id=$3
           AND lifecycle_state='active' AND record_version=$4`,
        values: [
          input.documentId,
          input.organizationId,
          input.caseId,
          input.expectedDocumentRecordVersion,
        ],
      });
      if (documentUpdated.rowCount !== 1) stale();

      const result = Object.freeze({
        id: input.versionId,
        recordVersion: input.expectedVersionRecordVersion + 1,
      });
      await appendEffects(transaction, input.effects);
      this.hooks.failBeforeCommit?.("abandon");
      await completeReceipt(transaction, input, ABANDON_OPERATION, result);
      return result;
    });
  }

  issueUploadIntent(input: Parameters<DocumentTransferRepository["issueUploadIntent"]>[0]) {
    return this.run(input, async (transaction) => {
      await assertActor(transaction, input);
      const serviceCase = await selectVisibleCase(transaction, input, input.caseId, true);
      if (!serviceCase) notFound();
      const document = await selectDocument(transaction, input, input.caseId, input.documentId, true);
      if (!document) notFound();
      if (serviceCase.stage === "closed" || serviceCase.student_status !== "active" ||
          document.lifecycle_state !== "active") {
        conflict();
      }
      const versionRow = await selectVersion(
        transaction,
        input,
        input.documentId,
        input.versionId,
        true,
      );
      if (!versionRow) notFound();
      if (version(versionRow.record_version) !== input.expectedRecordVersion) stale();
      if (versionRow.state !== "pending_upload" || versionRow.object_version_id !== null ||
          !isDocumentUploadContentType(versionRow.detected_content_type)) {
        conflict();
      }
      const result = await input.issue(pendingAuthority(versionRow));
      await appendEffects(transaction, input.effects);
      this.hooks.failBeforeCommit?.("upload_intent");
      return result;
    });
  }

  issueDownloadIntent(input: Parameters<DocumentTransferRepository["issueDownloadIntent"]>[0]) {
    return this.run(input, async (transaction) => {
      await assertActor(transaction, input);
      const serviceCase = await selectVisibleCase(transaction, input, input.caseId, true);
      if (!serviceCase) notFound();
      const document = await selectDocument(transaction, input, input.caseId, input.documentId, true);
      if (!document) notFound();
      if (document.lifecycle_state !== "active" || document.active_document_version_id === null) {
        conflict();
      }
      const row = await selectVersion(
        transaction,
        input,
        input.documentId,
        document.active_document_version_id,
        true,
      );
      if (!row) conflict();
      if (row.state !== "available" || row.revoked_at !== null ||
          row.object_version_id === null || row.object_version_id.trim() === "" ||
          !isDocumentUploadContentType(row.detected_content_type)) {
        conflict();
      }
      const authority: DocumentDownloadAuthority = Object.freeze({
        documentId: input.documentId,
        documentRecordVersion: version(document.record_version),
        versionId: row.id,
        versionRecordVersion: version(row.record_version),
        contentType: row.detected_content_type,
        bucket: row.object_bucket,
        key: row.object_key,
        providerVersionId: row.object_version_id,
      });
      const result = await input.issue(authority);
      await appendEffects(transaction, input.effects);
      this.hooks.failBeforeCommit?.("download_intent");
      return result;
    });
  }

  private async run<Result>(
    input: DocumentTransferActorContext,
    operation: (transaction: TenantTransaction) => Promise<Result>,
  ): Promise<Result> {
    try {
      return await this.runner.run(
        { organizationId: input.organizationId, actorUserId: input.actorUserId },
        async (transaction) => {
          try {
            return await operation(transaction);
          } catch (error) {
            if (isDocumentTransferError(error)) throw error;
            throw new DocumentTransferError("DOCUMENT_TRANSFER_UNAVAILABLE");
          }
        },
      );
    } catch (error) {
      if (isDocumentTransferError(error)) throw error;
      throw new DocumentTransferError("DOCUMENT_TRANSFER_UNAVAILABLE");
    }
  }
}

async function nextUploadGeneration(
  transaction: TenantTransaction,
  organizationId: string,
  documentId: string,
): Promise<number> {
  const result = await transaction.query<{ next_generation: number | string }>({
    text: `SELECT COALESCE(max(upload_generation),0)+1 AS next_generation
      FROM documents_document_versions
     WHERE organization_id=$1 AND document_id=$2`,
    values: [organizationId, documentId],
  });
  const next = result.rows[0]?.next_generation;
  return version(next ?? 0);
}

async function isLatestUploadGeneration(
  transaction: TenantTransaction,
  organizationId: string,
  documentId: string,
  uploadGeneration: number | string,
): Promise<boolean> {
  const result = await transaction.query<{ is_latest: boolean }>({
    text: `SELECT NOT EXISTS (
      SELECT 1 FROM documents_document_versions AS newer
       WHERE newer.organization_id=$1 AND newer.document_id=$2
         AND newer.upload_generation>$3
    ) AS is_latest`,
    values: [organizationId, documentId, version(uploadGeneration)],
  });
  return result.rows[0]?.is_latest === true;
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

async function assertActor(
  transaction: TenantTransaction,
  input: DocumentTransferActorContext,
): Promise<void> {
  const result = await transaction.query<ActorRow>({
    text: `SELECT binding.role
      FROM identity_users AS actor
      JOIN access_organization_memberships AS membership
        ON membership.user_id=actor.id AND membership.organization_id=$1
       AND membership.status='active'
      JOIN access_role_bindings AS binding
        ON binding.membership_id=membership.id
       AND binding.organization_id=membership.organization_id
       AND binding.user_id=actor.id AND binding.status='active'
      JOIN access_organizations AS organization
        ON organization.id=membership.organization_id AND organization.status='active'
     WHERE actor.id=$2 AND actor.status='active' AND binding.role=$3
     FOR SHARE OF actor,membership,binding,organization`,
    values: [input.organizationId, input.actorUserId, input.actorRole],
  });
  if (result.rowCount !== 1) forbidden();
}

async function selectVisibleCase(
  transaction: TenantTransaction,
  input: DocumentTransferActorContext,
  caseId: string,
  lock: boolean,
): Promise<CaseRow | null> {
  const result = await transaction.query<CaseRow>({
    text: `SELECT service_case.id,service_case.stage,student.status AS student_status
      FROM cases_service_cases AS service_case
      JOIN crm_students AS student
        ON student.id=service_case.student_id
       AND student.organization_id=service_case.organization_id
      JOIN access_role_bindings AS primary_binding
        ON primary_binding.id=service_case.primary_role_binding_id
       AND primary_binding.organization_id=service_case.organization_id
       AND primary_binding.user_id=service_case.primary_user_id
       AND primary_binding.role=service_case.primary_role
       AND primary_binding.status='active'
      JOIN access_organization_memberships AS primary_membership
        ON primary_membership.id=service_case.primary_membership_id
       AND primary_membership.organization_id=service_case.organization_id
       AND primary_membership.user_id=service_case.primary_user_id
       AND primary_membership.status='active'
      JOIN identity_users AS primary_actor
        ON primary_actor.id=service_case.primary_user_id AND primary_actor.status='active'
     WHERE service_case.id=$1 AND service_case.organization_id=$2
       AND ($3::text='founder' OR ($3='advisor' AND service_case.primary_role='advisor'
         AND service_case.primary_user_id=$4))
     ${lock ? "FOR UPDATE OF service_case FOR SHARE OF student,primary_binding,primary_membership,primary_actor" : ""}`,
    values: [caseId, input.organizationId, input.actorRole, input.actorUserId],
  });
  return result.rows[0] ?? null;
}

async function selectDocument(
  transaction: TenantTransaction,
  input: DocumentTransferActorContext,
  caseId: string,
  documentId: string,
  lock: boolean,
): Promise<DocumentRow | null> {
  const result = await transaction.query<DocumentRow>({
    text: `SELECT id,lifecycle_state,record_version,active_document_version_id
      FROM documents_documents
     WHERE id=$1 AND organization_id=$2 AND owner_kind='case' AND service_case_id=$3
     ${lock ? "FOR UPDATE" : ""}`,
    values: [documentId, input.organizationId, caseId],
  });
  return result.rows[0] ?? null;
}

async function selectVersion(
  transaction: TenantTransaction,
  input: DocumentTransferActorContext,
  documentId: string,
  versionId: string,
  lock: boolean,
): Promise<VersionRow | null> {
  const result = await transaction.query<VersionRow>({
    text: `SELECT id,document_id,record_version,detected_content_type,checksum_sha256,
        object_bucket,object_key,object_version_id,state,revoked_at,upload_generation
      FROM documents_document_versions
     WHERE id=$1 AND organization_id=$2 AND document_id=$3
     ${lock ? "FOR UPDATE" : ""}`,
    values: [versionId, input.organizationId, documentId],
  });
  return result.rows[0] ?? null;
}

function pendingAuthority(row: VersionRow): DocumentPendingUploadAuthority {
  if (!isDocumentUploadContentType(row.detected_content_type)) unavailable();
  return Object.freeze({
    id: row.id,
    documentId: row.document_id,
    recordVersion: version(row.record_version),
    contentType: row.detected_content_type,
    checksumSha256: row.checksum_sha256,
    bucket: row.object_bucket,
    key: row.object_key,
  });
}

async function claimReceipt(
  transaction: TenantTransaction,
  input: ReceiptInput,
  operation: typeof CREATE_OPERATION | typeof ABANDON_OPERATION,
): Promise<DocumentVersionAcknowledgement | null> {
  const inserted = await transaction.query({
    text: `INSERT INTO shared_idempotency_records
      (id,organization_id,actor_user_id,operation,idempotency_key,request_hash,state)
     VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,'in_progress')
     ON CONFLICT (organization_id,actor_user_id,operation,idempotency_key) DO NOTHING
     RETURNING id`,
    values: [
      input.organizationId,
      input.actorUserId,
      operation,
      input.idempotencyKey,
      input.requestHash,
    ],
  });
  const selected = await transaction.query<ReceiptRow>({
    text: `SELECT request_hash,state,result_reference,response_hash
      FROM shared_idempotency_records
     WHERE organization_id=$1 AND actor_user_id=$2 AND operation=$3 AND idempotency_key=$4
     FOR UPDATE`,
    values: [input.organizationId, input.actorUserId, operation, input.idempotencyKey],
  });
  if (inserted.rowCount === 1) return null;
  const row = selected.rows[0];
  if (!row || row.request_hash !== input.requestHash || row.state !== "completed" ||
      !row.result_reference || !row.response_hash) {
    conflict();
  }
  const result = parseReference(row.result_reference);
  if (row.response_hash !== hashAcknowledgement(result)) unavailable();
  return result;
}

async function completeReceipt(
  transaction: TenantTransaction,
  input: ReceiptInput,
  operation: typeof CREATE_OPERATION | typeof ABANDON_OPERATION,
  result: DocumentVersionAcknowledgement,
): Promise<void> {
  const completed = await transaction.query({
    text: `UPDATE shared_idempotency_records
      SET state='completed',result_reference=$5,response_hash=$6,
          record_version=record_version+1,updated_at=transaction_timestamp()
     WHERE organization_id=$1 AND actor_user_id=$2 AND operation=$3 AND idempotency_key=$4
       AND request_hash=$7 AND state='in_progress'`,
    values: [
      input.organizationId,
      input.actorUserId,
      operation,
      input.idempotencyKey,
      `${result.id}:${result.recordVersion}`,
      hashAcknowledgement(result),
      input.requestHash,
    ],
  });
  if (completed.rowCount !== 1) unavailable();
}

interface ReceiptInput extends DocumentTransferActorContext {
  readonly idempotencyKey: string;
  readonly requestHash: string;
}

function parseReference(value: string): DocumentVersionAcknowledgement {
  const match = REFERENCE.exec(value);
  if (!match) unavailable();
  return Object.freeze({ id: match[1]!, recordVersion: version(match[2]!) });
}

function hashAcknowledgement(value: DocumentVersionAcknowledgement): string {
  return hashRequestPayload({ id: value.id, record_version: value.recordVersion });
}

function version(value: number | string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) unavailable();
  return parsed;
}

function postgresCode(value: unknown): string | null {
  if (!(value instanceof Error)) return null;
  const code = (value as Error & { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function forbidden(): never {
  throw new DocumentTransferError("DOCUMENT_TRANSFER_FORBIDDEN");
}

function notFound(): never {
  throw new DocumentTransferError("DOCUMENT_TRANSFER_NOT_FOUND");
}

function stale(): never {
  throw new DocumentTransferError("DOCUMENT_TRANSFER_STALE_VERSION");
}

function conflict(): never {
  throw new DocumentTransferError("DOCUMENT_TRANSFER_CONFLICT");
}

function unavailable(): never {
  throw new DocumentTransferError("DOCUMENT_TRANSFER_UNAVAILABLE");
}
