import "server-only";

import { appendAtomicMutationEffects } from "../../audit/server.ts";
import { hashRequestPayload } from "../../shared/public.ts";
import type { TenantTransaction, TenantTransactionRunner } from "../../shared/server.ts";
import {
  CaseReferralSourceError,
  isCaseReferralSourceError,
  type CaseReferralSourceAcknowledgement,
  type CaseReferralSourceAssignmentRepository,
  type CaseReferralSourceAssignmentsView,
  type CaseReferralSourceAssignmentView,
} from "../application/referral-source-assignment-service.ts";
import type { ReferralSourceType } from "../../crm/public.ts";

const OPERATION = "cases.referral_source.assign";
const REFERENCE = /^([0-9a-f-]{36}):(\d{1,16})$/i;
interface ReceiptRow extends Record<string, unknown> { request_hash: string; state: string;
  result_reference: string | null; response_hash: string | null }
interface AssignmentRow extends Record<string, unknown> { id: string; referral_source_id: string;
  source_display_name: string; source_type: ReferralSourceType; source_record_version: number | string;
  starts_at: Date | string; ends_at: Date | string | null; record_version: number | string }
interface CaseRow extends Record<string, unknown> { id: string; stage: string; student_status: string;
  primary_user_id: string; primary_role: string }
interface SourceRow extends Record<string, unknown> { id: string; display_name: string;
  source_type: ReferralSourceType; status: string; record_version: number | string }

export class PostgresqlCaseReferralSourceAssignmentRepository implements CaseReferralSourceAssignmentRepository {
  private readonly runner: TenantTransactionRunner;
  constructor(runner: TenantTransactionRunner) { this.runner = runner; }

  read(input: Parameters<CaseReferralSourceAssignmentRepository["read"]>[0]) {
    return this.run(input, async (tx) => {
      await assertActor(tx, input);
      const serviceCase = await lockVisibleCase(tx, input, false);
      if (!serviceCase) return null;
      const rows = await tx.query<AssignmentRow>(`SELECT id,referral_source_id,source_display_name,
        source_type,source_record_version,starts_at,ends_at,record_version
        FROM cases_case_referral_source_assignments WHERE case_id=$1
        ORDER BY CASE WHEN ends_at IS NULL THEN 0 ELSE 1 END,ends_at DESC NULLS FIRST,id LIMIT 101`,
      [input.caseId]);
      const current = rows.rows.find((row) => row.ends_at === null);
      const history = rows.rows.filter((row) => row.ends_at !== null).slice(0, 100).map(view);
      return Object.freeze({ current: current ? view(current) : null,
        history: Object.freeze(history) }) satisfies CaseReferralSourceAssignmentsView;
    });
  }

  assign(input: Parameters<CaseReferralSourceAssignmentRepository["assign"]>[0]) {
    return this.run(input, async (tx) => {
      const replay = await claimReceipt(tx, input);
      await assertActor(tx, input);
      const serviceCase = await lockVisibleCase(tx, input, true);
      if (!serviceCase) notFound();
      if (replay) return replay;
      if (serviceCase.stage === "closed" || serviceCase.student_status !== "active") conflict();
      const sourceResult = await tx.query<SourceRow>(`SELECT id,display_name,source_type,status,record_version
        FROM crm_referral_sources WHERE id=$1 FOR SHARE`, [input.referralSourceId]);
      const source = sourceResult.rows[0]; if (!source) notFound();
      if (source.status !== "active") conflict();
      const currentResult = await tx.query<AssignmentRow>(`SELECT id,referral_source_id,source_display_name,
        source_type,source_record_version,starts_at,ends_at,record_version
        FROM cases_case_referral_source_assignments WHERE case_id=$1 AND ends_at IS NULL FOR UPDATE`,
      [input.caseId]);
      const current = currentResult.rows[0] ?? null;
      if (!current && input.expectedCurrentAssignmentRecordVersion !== null) stale();
      if (current && (input.expectedCurrentAssignmentRecordVersion === null ||
          version(current.record_version) !== input.expectedCurrentAssignmentRecordVersion)) stale();
      if (current?.referral_source_id === input.referralSourceId) conflict();
      if (current) {
        const closed = await tx.query(`UPDATE cases_case_referral_source_assignments
          SET ends_at=transaction_timestamp(),ended_by_assignment_id=$2,
              record_version=record_version+1,updated_at=transaction_timestamp()
          WHERE id=$1 AND ends_at IS NULL AND record_version=$3`,
        [current.id,input.assignmentId,input.expectedCurrentAssignmentRecordVersion]);
        if (closed.rowCount !== 1) stale();
      }
      const inserted = await tx.query<AssignmentRow>(`INSERT INTO cases_case_referral_source_assignments
        (id,organization_id,case_id,referral_source_id,source_display_name,source_type,
         source_record_version,starts_at,record_version)
        VALUES ($1,$2,$3,$4,$5,$6,$7,transaction_timestamp(),$8)
        RETURNING id,referral_source_id,source_display_name,source_type,source_record_version,
          starts_at,ends_at,record_version`,
      [input.assignmentId,input.organizationId,input.caseId,source.id,source.display_name,
        source.source_type,version(source.record_version),
        input.expectedCurrentAssignmentRecordVersion === null ? 1 :
          input.expectedCurrentAssignmentRecordVersion + 1]);
      const row = inserted.rows[0]; if (!row) unavailable();
      const acknowledgement = ack(row);
      await appendAtomicMutationEffects(tx, input.effects);
      await completeReceipt(tx, input, acknowledgement);
      return acknowledgement;
    });
  }

  private run<T>(input: { organizationId: string; actorUserId: string }, operation: (tx: Db) => Promise<T>) {
    return this.runner.run(input, async (tenantTx) => {
      try { return await operation(adapt(tenantTx)); }
      catch (cause) {
        if (isCaseReferralSourceError(cause)) throw cause;
        if (postgresConstraint(cause) === "cases_case_referral_source_assignments_one_current_idx") conflict();
        throw new CaseReferralSourceError("CASE_REFERRAL_SOURCE_UNAVAILABLE");
      }
    });
  }
}

async function assertActor(tx: Db, input: { organizationId: string; actorUserId: string; actorRole: string }) {
  if (!['founder','advisor'].includes(input.actorRole)) forbidden();
  const result = await tx.query(`SELECT binding.id FROM identity_users AS actor
    JOIN access_organization_memberships AS membership ON membership.user_id=actor.id
      AND membership.organization_id=$3 AND membership.status='active'
    JOIN access_role_bindings AS binding ON binding.membership_id=membership.id
      AND binding.organization_id=$3 AND binding.user_id=actor.id AND binding.status='active'
    JOIN access_organizations AS organization ON organization.id=$3 AND organization.status='active'
    WHERE actor.id=$1 AND actor.status='active' AND binding.role=$2
    FOR SHARE OF actor,membership,binding,organization`, [input.actorUserId,input.actorRole,input.organizationId]);
  if (result.rowCount !== 1) forbidden();
}
async function lockVisibleCase(tx: Db, input: { caseId: string; actorUserId: string; actorRole: string }, write: boolean) {
  const result = await tx.query<CaseRow>(`SELECT service_case.id,service_case.stage,
      student.status AS student_status,service_case.primary_user_id,service_case.primary_role
    FROM cases_service_cases AS service_case
    JOIN crm_students AS student ON student.id=service_case.student_id
    WHERE service_case.id=$1 AND ($2='founder' OR ($2='advisor' AND
      service_case.primary_role='advisor' AND service_case.primary_user_id=$3))
    ${write ? "FOR UPDATE OF service_case" : "FOR SHARE OF service_case"}`,
  [input.caseId,input.actorRole,input.actorUserId]);
  return result.rows[0] ?? null;
}
async function claimReceipt(tx: Db, input: { organizationId: string; actorUserId: string;
  idempotencyKey: string; requestHash: string }) {
  const inserted = await tx.query(`INSERT INTO shared_idempotency_records
    (id,organization_id,actor_user_id,operation,idempotency_key,request_hash,state)
    VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,'in_progress')
    ON CONFLICT (organization_id,actor_user_id,operation,idempotency_key) DO NOTHING RETURNING id`,
  [input.organizationId,input.actorUserId,OPERATION,input.idempotencyKey,input.requestHash]);
  const selected = await tx.query<ReceiptRow>(`SELECT request_hash,state,result_reference,response_hash
    FROM shared_idempotency_records WHERE organization_id=$1 AND actor_user_id=$2
      AND operation=$3 AND idempotency_key=$4 FOR UPDATE`,
  [input.organizationId,input.actorUserId,OPERATION,input.idempotencyKey]);
  if (inserted.rowCount === 1) return null;
  const row = selected.rows[0]; if (!row || row.request_hash !== input.requestHash ||
    row.state !== "completed" || !row.result_reference || !row.response_hash) conflict();
  const result = parseReference(row.result_reference);
  if (row.response_hash !== hashAcknowledgement(result)) unavailable();
  return result;
}
async function completeReceipt(tx: Db, input: { organizationId: string; actorUserId: string;
  idempotencyKey: string; requestHash: string }, result: CaseReferralSourceAcknowledgement) {
  const reference = `${result.id}:${result.recordVersion}`;
  const completed = await tx.query(`UPDATE shared_idempotency_records SET state='completed',
    result_reference=$5,response_hash=$6,record_version=record_version+1,updated_at=transaction_timestamp()
    WHERE organization_id=$1 AND actor_user_id=$2 AND operation=$3 AND idempotency_key=$4
      AND request_hash=$7 AND state='in_progress'`,
  [input.organizationId,input.actorUserId,OPERATION,input.idempotencyKey,reference,
    hashAcknowledgement(result),input.requestHash]);
  if (completed.rowCount !== 1) unavailable();
}
function parseReference(value: string): CaseReferralSourceAcknowledgement { const match = REFERENCE.exec(value);
  if (!match) unavailable(); return Object.freeze({ id: match[1]!, recordVersion: version(match[2]!) }); }
function hashAcknowledgement(value: CaseReferralSourceAcknowledgement) {
  return hashRequestPayload({ id: value.id, record_version: value.recordVersion }); }
function view(row: AssignmentRow): CaseReferralSourceAssignmentView { return Object.freeze({ id: row.id,
  referralSourceId: row.referral_source_id, sourceDisplayName: row.source_display_name,
  sourceType: row.source_type, sourceRecordVersion: version(row.source_record_version),
  startsAt: new Date(row.starts_at).toISOString(), endsAt: row.ends_at ? new Date(row.ends_at).toISOString() : null,
  recordVersion: version(row.record_version) }); }
function ack(row: AssignmentRow): CaseReferralSourceAcknowledgement {
  return Object.freeze({ id: row.id, recordVersion: version(row.record_version) }); }
function version(value: number | string) { const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 1) unavailable(); return number; }
function postgresConstraint(value: unknown) { if (!value || typeof value !== "object") return null;
  const error = value as { code?: unknown; constraint?: unknown }; return error.code === "23505" &&
    typeof error.constraint === "string" ? error.constraint : null; }
function forbidden(): never { throw new CaseReferralSourceError("CASE_REFERRAL_SOURCE_FORBIDDEN"); }
function notFound(): never { throw new CaseReferralSourceError("CASE_REFERRAL_SOURCE_NOT_FOUND"); }
function stale(): never { throw new CaseReferralSourceError("CASE_REFERRAL_SOURCE_STALE"); }
function conflict(): never { throw new CaseReferralSourceError("CASE_REFERRAL_SOURCE_CONFLICT"); }
function unavailable(): never { throw new CaseReferralSourceError("CASE_REFERRAL_SOURCE_UNAVAILABLE"); }
interface Db { query<Row extends Record<string, unknown> = Record<string, unknown>>(text: string,
  values?: readonly unknown[]): Promise<{ rows: readonly Row[]; rowCount: number }> }
function adapt(tx: TenantTransaction): Db { return Object.freeze({ async query<Row extends Record<string, unknown>>(
  text: string, values?: readonly unknown[]) { const result = await tx.query<Row>({ text, values });
  return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length }; } }); }
