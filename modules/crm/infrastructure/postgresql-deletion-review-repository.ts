import "server-only";

import { appendAtomicMutationEffects } from "../../audit/server.ts";
import { hashRequestPayload } from "../../shared/public.ts";
import type { TenantTransaction, TenantTransactionRunner } from "../../shared/server.ts";
import {
  DeletionReviewError,
  isDeletionReviewError,
  type DeletionEntityType,
  type DeletionRequestReceipt,
  type DeletionRequestSummary,
  type DeletionReviewRepository,
} from "../application/deletion-review-service.ts";

const OPERATIONS = Object.freeze({ student: "crm.request_student_pending_delete",
  guardian: "crm.request_guardian_pending_delete" } as const);
const REFERENCE = /^([0-9a-f-]{36}):(\d{1,16}):(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)$/i;
const POSTGRES_SEVERITIES = new Set([
  "ERROR", "FATAL", "PANIC", "WARNING", "NOTICE", "DEBUG", "INFO", "LOG",
]);
const POSTGRES_CODES = new Set([
  "08003", "08006", "23503", "23505", "23514", "40001", "40P01", "42501",
  "42601", "42703", "42883", "42P01", "55P03", "57014", "57P01",
]);

export const DELETION_REVIEW_FAILURE_STAGES = Object.freeze([
  "receipt_claim", "actor_reauthorization", "target_lock", "advisor_scope",
  "target_update", "effects_append", "receipt_complete", "transaction_boundary",
] as const);
export type DeletionReviewFailureStage = (typeof DELETION_REVIEW_FAILURE_STAGES)[number];
export type DeletionReviewSafePostgresCode =
  | "08003" | "08006" | "23503" | "23505" | "23514" | "40001" | "40P01"
  | "42501" | "42601" | "42703" | "42883" | "42P01" | "55P03" | "57014"
  | "57P01" | "OTHER" | null;
export interface DeletionReviewFailureEvidence {
  readonly stage: DeletionReviewFailureStage;
  readonly postgresCode: DeletionReviewSafePostgresCode;
}
export type DeletionReviewFailureObserver = (evidence: DeletionReviewFailureEvidence) => void;

interface ReceiptRow extends Record<string, unknown> {
  request_hash: string; state: string; result_reference: string | null; response_hash: string | null;
}
interface TargetRow extends Record<string, unknown> {
  id: string; display_name: string; status: string; deletion_requested_at: Date | string | null;
  record_version: number | string;
}
interface QueueRow extends Record<string, unknown> {
  entity_type: DeletionEntityType; entity_id: string; display_label: string;
  status: "pending_delete"; deletion_requested_at: Date | string; record_version: number | string;
}

export class PostgresqlDeletionReviewRepository implements DeletionReviewRepository {
  private readonly runner: TenantTransactionRunner;
  private readonly observeFailure: DeletionReviewFailureObserver;
  constructor(runner: TenantTransactionRunner, observeFailure: DeletionReviewFailureObserver = writeSafeFailure) {
    this.runner = runner;
    this.observeFailure = observeFailure;
  }

  requestDeletion(input: Parameters<DeletionReviewRepository["requestDeletion"]>[0]) {
    return this.run(input, async (tx) => {
      const operation = OPERATIONS[input.entityType];
      const receipt = await this.at("receipt_claim", () => claimReceipt(tx, input, operation));
      await this.at("actor_reauthorization", () => assertActor(tx, input, "request"));
      const target = await this.at("target_lock", () => lockTarget(tx, input.entityType, input.entityId));
      if (!target || target.status === "purged") notFound();
      if (!await this.at("advisor_scope", () => canRequest(tx, input))) notFound();
      if (receipt) {
        const replay = parseReference(receipt.result_reference, input.entityType, input.entityId);
        assertResponseHash(receipt.response_hash, replay);
        return replay;
      }
      if (target.status !== "active") conflict();
      if (version(target.record_version) !== input.expectedRecordVersion) stale();
      const table = tableFor(input.entityType);
      const updated = await this.at("target_update", () => tx.query<TargetRow>(`UPDATE ${table}
        SET status='pending_delete', deletion_requested_at=transaction_timestamp(),
            deletion_requested_by_user_id=$2, deletion_reason=$4, record_version=record_version+1,
            updated_at=transaction_timestamp()
        WHERE id=$1 AND status='active' AND record_version=$3
        RETURNING id,display_name,status,deletion_requested_at,record_version`,
      [input.entityId, input.actorUserId, input.expectedRecordVersion, input.reasonCode]));
      const row = updated.rows[0]; if (!row || !row.deletion_requested_at) stale();
      const result = toReceipt(input.entityType, row);
      await this.at("effects_append", () => appendAtomicMutationEffects(tx, input.effects));
      await this.at("receipt_complete", () => completeReceipt(tx, input, operation, result));
      return result;
    });
  }

  listDeletionRequests(input: Parameters<DeletionReviewRepository["listDeletionRequests"]>[0]) {
    return this.run(input, async (tx) => {
      await this.at("actor_reauthorization", () => assertActor(tx, input, "review"));
      const rows = await tx.query<QueueRow>(`SELECT entity_type,entity_id,display_label,status,
        deletion_requested_at,record_version FROM (
          SELECT 'student'::text AS entity_type,id AS entity_id,display_name AS display_label,
            status,deletion_requested_at,record_version FROM crm_students WHERE status='pending_delete'
          UNION ALL
          SELECT 'guardian'::text AS entity_type,id AS entity_id,display_name AS display_label,
            status,deletion_requested_at,record_version FROM crm_guardians WHERE status='pending_delete'
        ) AS queue WHERE ($1::text IS NULL OR entity_type=$1)
        ORDER BY deletion_requested_at DESC,entity_id ASC LIMIT 100`, [input.entityType]);
      return Object.freeze(rows.rows.map(toSummary));
    });
  }

  private async run<T>(input: { organizationId: string; actorUserId: string }, operation: (tx: Db) => Promise<T>) {
    try {
      return await this.runner.run(input, async (tenantTx) => {
        try { return await operation(adapt(tenantTx)); }
        catch (cause) {
          if (isDeletionReviewError(cause)) throw cause;
          throw new DeletionReviewError("DELETION_REVIEW_UNAVAILABLE");
        }
      });
    } catch (cause) {
      if (!isDeletionReviewError(cause)) this.report("transaction_boundary", cause);
      throw cause;
    }
  }

  private async at<T>(stage: DeletionReviewFailureStage, operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (cause) {
      if (!isDeletionReviewError(cause)) this.report(stage, cause);
      throw cause;
    }
  }

  private report(stage: DeletionReviewFailureStage, cause: unknown): void {
    this.observeFailure(Object.freeze({ stage, postgresCode: readSafePostgresCode(cause) }));
  }
}

function readSafePostgresCode(cause: unknown): DeletionReviewSafePostgresCode {
  if (!(cause instanceof Error)) return null;
  const candidate = cause as Error & { readonly code?: unknown; readonly severity?: unknown };
  if (typeof candidate.code !== "string" || !/^[0-9A-Z]{5}$/.test(candidate.code) ||
      typeof candidate.severity !== "string" || !POSTGRES_SEVERITIES.has(candidate.severity)) return null;
  return POSTGRES_CODES.has(candidate.code) ? candidate.code as DeletionReviewSafePostgresCode : "OTHER";
}

function writeSafeFailure(evidence: DeletionReviewFailureEvidence): void {
  process.stderr.write(`event=deletion_review_postgres_failure stage=${evidence.stage} ` +
    `postgres_code=${evidence.postgresCode ?? "NULL"}\n`);
}

async function assertActor(tx: Db, input: { organizationId: string; actorUserId: string; actorRole: string },
  mode: "request" | "review") {
  if ((mode === "review" && input.actorRole !== "founder") ||
      (mode === "request" && !["founder", "advisor"].includes(input.actorRole))) forbidden();
  const result = await tx.query(`SELECT binding.id FROM identity_users AS actor
    JOIN access_organization_memberships AS membership ON membership.user_id=actor.id
      AND membership.organization_id=$3 AND membership.status='active'
    JOIN access_role_bindings AS binding ON binding.membership_id=membership.id
      AND binding.organization_id=$3 AND binding.user_id=actor.id AND binding.status='active'
    JOIN access_organizations AS organization ON organization.id=$3
      AND organization.status='active'
    WHERE actor.id=$1 AND actor.status='active' AND binding.role=$2 FOR SHARE OF actor,membership,binding,organization`,
  [input.actorUserId, input.actorRole, input.organizationId]);
  if (result.rowCount !== 1) forbidden();
}
async function canRequest(tx: Db, input: { actorRole: string; actorUserId: string;
  entityType: DeletionEntityType; entityId: string }) {
  if (input.actorRole === "founder") return true;
  if (input.actorRole !== "advisor") return false;
  const student = input.entityType === "student" ? "$1" : "relationship.student_id";
  const relationship = input.entityType === "guardian" ?
    "JOIN crm_student_guardian_relationships AS relationship ON relationship.guardian_id=$1 AND relationship.ends_at IS NULL" : "";
  const result = await tx.query(`SELECT service_case.id FROM cases_service_cases AS service_case ${relationship}
    WHERE service_case.student_id=${student} AND service_case.primary_user_id=$2
      AND service_case.primary_role='advisor' AND service_case.stage<>'closed' LIMIT 1 FOR SHARE OF service_case`,
  [input.entityId, input.actorUserId]);
  return result.rowCount === 1;
}
async function lockTarget(tx: Db, entity: DeletionEntityType, id: string) {
  const result = await tx.query<TargetRow>(`SELECT id,display_name,status,deletion_requested_at,record_version
    FROM ${tableFor(entity)} WHERE id=$1 FOR UPDATE`, [id]);
  return result.rows[0] ?? null;
}
async function claimReceipt(tx: Db, input: {organizationId:string;actorUserId:string;idempotencyKey:string;requestHash:string}, operation:string) {
  const claim = await tx.query(`INSERT INTO shared_idempotency_records
    (id,organization_id,actor_user_id,operation,idempotency_key,request_hash,state)
    VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,'in_progress')
    ON CONFLICT (organization_id,actor_user_id,operation,idempotency_key) DO NOTHING RETURNING id`,
  [input.organizationId,input.actorUserId,operation,input.idempotencyKey,input.requestHash]);
  const result=await tx.query<ReceiptRow>(`SELECT request_hash,state,result_reference,response_hash
    FROM shared_idempotency_records WHERE organization_id=$1 AND actor_user_id=$2
    AND operation=$3 AND idempotency_key=$4 FOR UPDATE`,
  [input.organizationId,input.actorUserId,operation,input.idempotencyKey]);
  if(claim.rowCount===1) return null; const row=result.rows[0];
  if(!row || row.request_hash!==input.requestHash || row.state!=="completed" ||
      !row.result_reference || !row.response_hash) conflict();
  return Object.freeze({ result_reference: row.result_reference, response_hash: row.response_hash });
}
async function completeReceipt(tx:Db,input:{organizationId:string;actorUserId:string;idempotencyKey:string;requestHash:string},
  operation:string,result:DeletionRequestReceipt){
  const reference=`${result.entityId}:${result.recordVersion}:${result.deletionRequestedAt}`;
  if(reference.length>128) unavailable();
  const completed=await tx.query(`UPDATE shared_idempotency_records SET state='completed',result_reference=$5,
    response_hash=$6,record_version=record_version+1,updated_at=transaction_timestamp()
    WHERE organization_id=$1 AND actor_user_id=$2 AND operation=$3 AND idempotency_key=$4
    AND request_hash=$7 AND state='in_progress'`,[input.organizationId,input.actorUserId,operation,
    input.idempotencyKey,reference,hashReceipt(result),input.requestHash]);
  if(completed.rowCount!==1) unavailable();
}
function parseReference(value:string,entity:DeletionEntityType,expectedId:string):DeletionRequestReceipt{
  const match=REFERENCE.exec(value);if(!match || match[1]!==expectedId)unavailable();
  const recordVersion=version(match[2]!);const deletionRequestedAt=new Date(match[3]!).toISOString();
  return Object.freeze({entityType:entity,entityId:expectedId,status:"pending_delete",deletionRequestedAt,recordVersion});}
function assertResponseHash(actual:string,result:DeletionRequestReceipt){if(actual!==hashReceipt(result))unavailable();}
function hashReceipt(result:DeletionRequestReceipt){return hashRequestPayload({entity_type:result.entityType,
  entity_id:result.entityId,status:result.status,deletion_requested_at:result.deletionRequestedAt,
  record_version:result.recordVersion});}
function toReceipt(entity:DeletionEntityType,row:TargetRow):DeletionRequestReceipt{return Object.freeze({entityType:entity,
  entityId:row.id,status:"pending_delete",deletionRequestedAt:new Date(row.deletion_requested_at!).toISOString(),
  recordVersion:version(row.record_version)});}
function toSummary(row:QueueRow):DeletionRequestSummary{return Object.freeze({...toReceipt(row.entity_type,{id:row.entity_id,
  display_name:row.display_label,status:row.status,deletion_requested_at:row.deletion_requested_at,
  record_version:row.record_version}),displayLabel:row.display_label});}
function tableFor(entity:DeletionEntityType){return entity==="student"?"crm_students":"crm_guardians";}
function version(value:number|string){const n=typeof value==="number"?value:Number(value);if(!Number.isSafeInteger(n)||n<1)unavailable();return n;}
function forbidden():never{throw new DeletionReviewError("DELETION_REVIEW_FORBIDDEN");}
function notFound():never{throw new DeletionReviewError("DELETION_REVIEW_NOT_FOUND");}
function stale():never{throw new DeletionReviewError("DELETION_REVIEW_STALE");}
function conflict():never{throw new DeletionReviewError("DELETION_REVIEW_CONFLICT");}
function unavailable():never{throw new DeletionReviewError("DELETION_REVIEW_UNAVAILABLE");}
interface Db{query<Row extends Record<string,unknown>=Record<string,unknown>>(text:string,values?:readonly unknown[]):Promise<{rows:readonly Row[];rowCount:number}>;}
function adapt(tx:TenantTransaction):Db{return Object.freeze({async query<Row extends Record<string,unknown>>(text:string,values?:readonly unknown[]){const result=await tx.query<Row>({text,values});return {rows:result.rows,rowCount:result.rowCount??result.rows.length};}});}
