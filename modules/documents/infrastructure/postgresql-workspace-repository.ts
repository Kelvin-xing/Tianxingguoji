import "server-only";

import { appendAtomicMutationEffects } from "../../audit/server.ts";
import { hashRequestPayload } from "../../shared/public.ts";
import type { TenantTransaction, TenantTransactionRunner } from "../../shared/server.ts";
import { DOCUMENT_VERSION_STATES, type DocumentVersionState } from "../domain/contract.ts";
import {
  DocumentWorkspaceError,
  isCaseDocumentClassification,
  isDocumentWorkspaceError,
  type CaseDocumentView,
  type DocumentAcknowledgement,
  type DocumentActorContext,
  type DocumentWorkspaceRepository,
  type VisibleDocumentLifecycleState,
} from "../application/workspace-service.ts";

const REGISTER_OPERATION = "documents.register_case_metadata";
const REFERENCE = /^([0-9a-f-]{36}):(\d{1,16})$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  service_case_id: string;
  case_number: string;
  display_name: string;
  classification: string;
  lifecycle_state: string;
  latest_version_state: string | null;
  latest_version_id: string | null;
  latest_version_record_version: number | string | null;
  has_active_version: boolean;
  record_version: number | string;
  updated_at: Date | string;
}

interface ReceiptRow extends Record<string, unknown> {
  request_hash: string;
  state: string;
  result_reference: string | null;
  response_hash: string | null;
}

export interface DocumentRepositoryTestHooks {
  readonly failBeforeCommit?: () => void;
}

export class PostgresqlDocumentWorkspaceRepository implements DocumentWorkspaceRepository {
  private readonly runner: TenantTransactionRunner;
  private readonly hooks: DocumentRepositoryTestHooks;

  constructor(runner: TenantTransactionRunner, hooks: DocumentRepositoryTestHooks = {}) {
    this.runner = runner;
    this.hooks = hooks;
  }

  list(input: Parameters<DocumentWorkspaceRepository["list"]>[0]) {
    return this.run(input, async (transaction) => {
      await assertActor(transaction, input);
      if (input.caseId !== null) {
        const serviceCase = await selectVisibleCase(transaction, input, input.caseId, false);
        if (!serviceCase) return null;
      }
      const rows = await selectVisibleDocuments(transaction, input, input.caseId, null);
      return Object.freeze({ documents: Object.freeze(rows.map(documentView)) });
    });
  }

  detail(input: Parameters<DocumentWorkspaceRepository["detail"]>[0]) {
    return this.run(input, async (transaction) => {
      await assertActor(transaction, input);
      const serviceCase = await selectVisibleCase(transaction, input, input.caseId, false);
      if (!serviceCase) return null;
      const rows = await selectVisibleDocuments(
        transaction,
        input,
        input.caseId,
        input.documentId,
      );
      return rows[0] ? documentView(rows[0]) : null;
    });
  }

  register(input: Parameters<DocumentWorkspaceRepository["register"]>[0]) {
    return this.run(input, async (transaction) => {
      const replay = await claimReceipt(transaction, input);
      await assertActor(transaction, input);
      const serviceCase = await selectVisibleCase(transaction, input, input.caseId, true);
      if (!serviceCase || serviceCase.student_status !== "active") notFound();
      if (serviceCase.stage === "closed") conflict();
      if (replay) return replay;

      const inserted = await transaction.query({
        text: `INSERT INTO documents_documents
          (id,organization_id,owner_kind,student_id,service_case_id,task_id,display_name,
           classification,lifecycle_state,active_document_version_id,legal_hold,
           legal_hold_reason,soft_deleted_at,retention_ends_at,purge_approved_by_user_id,
           purge_approved_at,purge_reason,record_version)
         VALUES ($1,$2,'case',NULL,$3,NULL,$4,$5,'active',NULL,false,
           NULL,NULL,NULL,NULL,NULL,NULL,1)`,
        values: [
          input.documentId,
          input.organizationId,
          input.caseId,
          input.displayName,
          input.classification,
        ],
      });
      if (inserted.rowCount !== 1) unavailable();

      const result = Object.freeze({ id: input.documentId, recordVersion: 1 });
      await appendAtomicMutationEffects(asAtomicTransaction(transaction), input.effects);
      this.hooks.failBeforeCommit?.();
      await completeReceipt(transaction, input, result);
      return result;
    });
  }

  private run<Result>(
    input: DocumentActorContext,
    operation: (transaction: TenantTransaction) => Promise<Result>,
  ): Promise<Result> {
    return this.runner.run(
      { organizationId: input.organizationId, actorUserId: input.actorUserId },
      async (transaction) => {
        try {
          return await operation(transaction);
        } catch (error) {
          if (isDocumentWorkspaceError(error)) throw error;
          throw new DocumentWorkspaceError("DOCUMENT_WORKSPACE_UNAVAILABLE");
        }
      },
    );
  }
}

function asAtomicTransaction(
  transaction: TenantTransaction,
): Parameters<typeof appendAtomicMutationEffects>[0] {
  return Object.freeze({
    async query<Row extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      values?: readonly unknown[],
    ) {
      const result = await transaction.query<Row>({ text, values });
      return Object.freeze({
        rows: result.rows,
        rowCount: result.rowCount ?? result.rows.length,
      });
    },
  });
}

async function assertActor(
  transaction: TenantTransaction,
  input: DocumentActorContext,
): Promise<void> {
  const result = await transaction.query<ActorRow>({
    text: `SELECT binding.role
      FROM identity_users AS actor
      JOIN access_organization_memberships AS membership
        ON membership.user_id=actor.id
       AND membership.organization_id=$1
       AND membership.status='active'
      JOIN access_role_bindings AS binding
        ON binding.membership_id=membership.id
       AND binding.organization_id=membership.organization_id
       AND binding.user_id=actor.id
       AND binding.status='active'
      JOIN access_organizations AS organization
        ON organization.id=membership.organization_id
       AND organization.status='active'
     WHERE actor.id=$2 AND actor.status='active' AND binding.role=$3
     FOR SHARE OF actor,membership,binding,organization`,
    values: [input.organizationId, input.actorUserId, input.actorRole],
  });
  if (result.rowCount !== 1) forbidden();
}

async function selectVisibleCase(
  transaction: TenantTransaction,
  input: DocumentActorContext,
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
        ON primary_actor.id=service_case.primary_user_id
       AND primary_actor.status='active'
     WHERE service_case.id=$1 AND service_case.organization_id=$2
       AND ($3::text='founder' OR ($3='advisor' AND (
         (service_case.primary_role='advisor' AND service_case.primary_user_id=$4)
         OR EXISTS (SELECT 1 FROM tasks_tasks AS assigned_task
             WHERE assigned_task.organization_id=service_case.organization_id
               AND assigned_task.service_case_id=service_case.id
               AND (assigned_task.assignee_user_id=$4 OR assigned_task.owner_user_id=$4))
       )))
     ${lock ? "FOR UPDATE OF service_case FOR SHARE OF student,primary_binding,primary_membership,primary_actor" : ""}`,
    values: [caseId, input.organizationId, input.actorRole, input.actorUserId],
  });
  return result.rows[0] ?? null;
}

async function selectVisibleDocuments(
  transaction: TenantTransaction,
  input: DocumentActorContext,
  caseId: string | null,
  documentId: string | null,
): Promise<readonly DocumentRow[]> {
  const result = await transaction.query<DocumentRow>({
    text: `SELECT document.id,document.service_case_id,service_case.case_number,
        document.display_name,document.classification,document.lifecycle_state,
        latest_version.state AS latest_version_state,
        latest_version.id AS latest_version_id,
        latest_version.record_version AS latest_version_record_version,
        EXISTS (
          SELECT 1 FROM documents_document_versions AS active_version
           WHERE active_version.id=document.active_document_version_id
             AND active_version.organization_id=document.organization_id
             AND active_version.document_id=document.id
             AND active_version.state='available' AND active_version.revoked_at IS NULL
        ) AS has_active_version,
        document.record_version,document.updated_at
      FROM documents_documents AS document
      JOIN cases_service_cases AS service_case
        ON service_case.id=document.service_case_id
       AND service_case.organization_id=document.organization_id
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
        ON primary_actor.id=service_case.primary_user_id
       AND primary_actor.status='active'
      LEFT JOIN LATERAL (
        SELECT version.id,version.state,version.record_version
          FROM documents_document_versions AS version
         WHERE version.document_id=document.id
           AND version.organization_id=document.organization_id
         ORDER BY version.upload_generation DESC
         LIMIT 1
      ) AS latest_version ON true
     WHERE document.organization_id=$1
       AND document.owner_kind='case'
       AND document.lifecycle_state IN ('active','pending_delete')
       AND ($2::uuid IS NULL OR document.service_case_id=$2)
       AND ($3::uuid IS NULL OR document.id=$3)
       AND ($4::text='founder' OR ($4='advisor' AND (
         (service_case.primary_role='advisor' AND service_case.primary_user_id=$5)
         OR EXISTS (SELECT 1 FROM tasks_tasks AS assigned_task
             WHERE assigned_task.organization_id=service_case.organization_id
               AND assigned_task.service_case_id=service_case.id
               AND (assigned_task.assignee_user_id=$5 OR assigned_task.owner_user_id=$5))
       )))
     ORDER BY document.updated_at DESC,document.id ASC
     LIMIT 100`,
    values: [input.organizationId, caseId, documentId, input.actorRole, input.actorUserId],
  });
  return result.rows;
}

async function claimReceipt(
  transaction: TenantTransaction,
  input: Parameters<DocumentWorkspaceRepository["register"]>[0],
): Promise<DocumentAcknowledgement | null> {
  const inserted = await transaction.query({
    text: `INSERT INTO shared_idempotency_records
      (id,organization_id,actor_user_id,operation,idempotency_key,request_hash,state)
     VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,'in_progress')
     ON CONFLICT (organization_id,actor_user_id,operation,idempotency_key) DO NOTHING
     RETURNING id`,
    values: [
      input.organizationId,
      input.actorUserId,
      REGISTER_OPERATION,
      input.idempotencyKey,
      input.requestHash,
    ],
  });
  const selected = await transaction.query<ReceiptRow>({
    text: `SELECT request_hash,state,result_reference,response_hash
      FROM shared_idempotency_records
     WHERE organization_id=$1 AND actor_user_id=$2 AND operation=$3 AND idempotency_key=$4
     FOR UPDATE`,
    values: [
      input.organizationId,
      input.actorUserId,
      REGISTER_OPERATION,
      input.idempotencyKey,
    ],
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
  input: Parameters<DocumentWorkspaceRepository["register"]>[0],
  result: DocumentAcknowledgement,
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
      REGISTER_OPERATION,
      input.idempotencyKey,
      `${result.id}:${result.recordVersion}`,
      hashAcknowledgement(result),
      input.requestHash,
    ],
  });
  if (completed.rowCount !== 1) unavailable();
}

function documentView(row: DocumentRow): CaseDocumentView {
  if (!isCaseDocumentClassification(row.classification) ||
      !isVisibleLifecycle(row.lifecycle_state) ||
      !isDocumentVersionStateOrNull(row.latest_version_state)) {
    unavailable();
  }
  const pendingUpload = pendingUploadView(row);
  return Object.freeze({
    id: row.id,
    caseId: row.service_case_id,
    caseNumber: row.case_number,
    displayName: row.display_name,
    classification: row.classification,
    lifecycleState: row.lifecycle_state,
    latestVersionState: row.latest_version_state,
    pendingUpload,
    hasActiveVersion: row.has_active_version,
    recordVersion: version(row.record_version),
    updatedAt: new Date(row.updated_at).toISOString(),
  });
}

function pendingUploadView(
  row: Pick<DocumentRow, "latest_version_id" | "latest_version_record_version" | "latest_version_state">,
): CaseDocumentView["pendingUpload"] {
  if (row.latest_version_state === null) {
    if (row.latest_version_id !== null || row.latest_version_record_version !== null) unavailable();
    return null;
  }
  if (!row.latest_version_id || !UUID.test(row.latest_version_id) ||
      row.latest_version_record_version === null) {
    unavailable();
  }
  if (row.latest_version_state !== "pending_upload") return null;
  return Object.freeze({
    id: row.latest_version_id,
    recordVersion: version(row.latest_version_record_version),
  });
}

function isVisibleLifecycle(value: string): value is VisibleDocumentLifecycleState {
  return value === "active" || value === "pending_delete";
}

function isDocumentVersionStateOrNull(value: string | null): value is DocumentVersionState | null {
  return value === null || (DOCUMENT_VERSION_STATES as readonly string[]).includes(value);
}

function parseReference(value: string): DocumentAcknowledgement {
  const match = REFERENCE.exec(value);
  if (!match) unavailable();
  return Object.freeze({ id: match[1]!, recordVersion: version(match[2]!) });
}

function hashAcknowledgement(value: DocumentAcknowledgement): string {
  return hashRequestPayload({ id: value.id, record_version: value.recordVersion });
}

function version(value: number | string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) unavailable();
  return parsed;
}

function forbidden(): never {
  throw new DocumentWorkspaceError("DOCUMENT_WORKSPACE_FORBIDDEN");
}

function notFound(): never {
  throw new DocumentWorkspaceError("DOCUMENT_WORKSPACE_NOT_FOUND");
}

function conflict(): never {
  throw new DocumentWorkspaceError("DOCUMENT_WORKSPACE_CONFLICT");
}

function unavailable(): never {
  throw new DocumentWorkspaceError("DOCUMENT_WORKSPACE_UNAVAILABLE");
}
