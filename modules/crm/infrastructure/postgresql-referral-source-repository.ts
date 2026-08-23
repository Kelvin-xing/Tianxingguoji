import "server-only";

import { appendAtomicMutationEffects } from "../../audit/server.ts";
import { hashRequestPayload } from "../../shared/public.ts";
import type { TenantTransaction, TenantTransactionRunner } from "../../shared/server.ts";
import {
  ReferralSourceError,
  isReferralSourceError,
  type ReferralSourceAcknowledgement,
  type ReferralSourceRepository,
  type ReferralSourceStatus,
  type ReferralSourceType,
  type ReferralSourceView,
} from "../application/referral-source-service.ts";

const CREATE_OPERATION = "crm.referral_source.create";
const UPDATE_OPERATION = "crm.referral_source.update";
const REFERENCE = /^([0-9a-f-]{36}):(\d{1,16})$/i;

interface SourceRow extends Record<string, unknown> {
  id: string; display_name: string; source_type: ReferralSourceType;
  status: ReferralSourceStatus; record_version: number | string;
}
interface ReceiptRow extends Record<string, unknown> {
  request_hash: string; state: string; result_reference: string | null; response_hash: string | null;
}

export class PostgresqlReferralSourceRepository implements ReferralSourceRepository {
  private readonly runner: TenantTransactionRunner;
  constructor(runner: TenantTransactionRunner) { this.runner = runner; }

  list(input: Parameters<ReferralSourceRepository["list"]>[0]) {
    return this.run(input, async (tx) => {
      await assertActor(tx, input, "read");
      const result = await tx.query<SourceRow>(`SELECT id,display_name,source_type,status,record_version
        FROM crm_referral_sources WHERE ($1::text IS NULL OR status=$1)
        ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END,display_name COLLATE "C",id LIMIT 100`,
      [input.status]);
      return Object.freeze(result.rows.map(view));
    });
  }

  find(input: Parameters<ReferralSourceRepository["find"]>[0]) {
    return this.run(input, async (tx) => {
      await assertActor(tx, input, "read");
      const result = await tx.query<SourceRow>(`SELECT id,display_name,source_type,status,record_version
        FROM crm_referral_sources WHERE id=$1`, [input.sourceId]);
      return result.rows[0] ? view(result.rows[0]) : null;
    });
  }

  create(input: Parameters<ReferralSourceRepository["create"]>[0]) {
    return this.run(input, async (tx) => {
      const replay = await claimReceipt(tx, input, CREATE_OPERATION);
      await assertActor(tx, input, "manage");
      if (replay) return replay;
      const result = await tx.query<SourceRow>(`INSERT INTO crm_referral_sources
        (id,organization_id,display_name,source_type,status,record_version)
        VALUES ($1,$2,$3,$4,'active',1)
        RETURNING id,display_name,source_type,status,record_version`,
      [input.sourceId, input.organizationId, input.displayName, input.sourceType]);
      const row = result.rows[0]; if (!row) unavailable();
      const acknowledgement = ack(row);
      await appendAtomicMutationEffects(tx, input.effects);
      await completeReceipt(tx, input, CREATE_OPERATION, acknowledgement);
      return acknowledgement;
    });
  }

  update(input: Parameters<ReferralSourceRepository["update"]>[0]) {
    return this.run(input, async (tx) => {
      const replay = await claimReceipt(tx, input, UPDATE_OPERATION);
      await assertActor(tx, input, "manage");
      if (replay) return replay;
      const locked = await tx.query<SourceRow>(`SELECT id,display_name,source_type,status,record_version
        FROM crm_referral_sources WHERE id=$1 FOR UPDATE`, [input.sourceId]);
      const current = locked.rows[0]; if (!current) notFound();
      if (version(current.record_version) !== input.expectedRecordVersion) stale();
      if (current.status === "inactive" && input.status === "active") conflict();
      if (current.display_name === input.displayName && current.status === input.status) conflict();
      const updated = await tx.query<SourceRow>(`UPDATE crm_referral_sources
        SET display_name=$2,status=$3,record_version=record_version+1,updated_at=transaction_timestamp()
        WHERE id=$1 AND record_version=$4
        RETURNING id,display_name,source_type,status,record_version`,
      [input.sourceId, input.displayName, input.status, input.expectedRecordVersion]);
      const row = updated.rows[0]; if (!row) stale();
      const acknowledgement = ack(row);
      await appendAtomicMutationEffects(tx, input.effects);
      await completeReceipt(tx, input, UPDATE_OPERATION, acknowledgement);
      return acknowledgement;
    });
  }

  private run<T>(input: { organizationId: string; actorUserId: string }, operation: (tx: Db) => Promise<T>) {
    return this.runner.run(input, async (tenantTx) => {
      try { return await operation(adapt(tenantTx)); }
      catch (cause) { if (isReferralSourceError(cause)) throw cause; throw new ReferralSourceError("REFERRAL_SOURCE_UNAVAILABLE"); }
    });
  }
}

async function assertActor(tx: Db, input: { organizationId: string; actorUserId: string; actorRole: string },
  mode: "read" | "manage") {
  const roles = mode === "read" ? ["founder", "admin", "advisor"] : ["founder", "admin"];
  if (!roles.includes(input.actorRole)) forbidden();
  const result = await tx.query(`SELECT binding.id FROM identity_users AS actor
    JOIN access_organization_memberships AS membership ON membership.user_id=actor.id
      AND membership.organization_id=$3 AND membership.status='active'
    JOIN access_role_bindings AS binding ON binding.membership_id=membership.id
      AND binding.organization_id=$3 AND binding.user_id=actor.id AND binding.status='active'
    JOIN access_organizations AS organization ON organization.id=$3 AND organization.status='active'
    WHERE actor.id=$1 AND actor.status='active' AND binding.role=$2
    FOR SHARE OF actor,membership,binding,organization`, [input.actorUserId, input.actorRole, input.organizationId]);
  if (result.rowCount !== 1) forbidden();
}
async function claimReceipt(tx: Db, input: { organizationId: string; actorUserId: string;
  idempotencyKey: string; requestHash: string }, operation: string) {
  const inserted = await tx.query(`INSERT INTO shared_idempotency_records
    (id,organization_id,actor_user_id,operation,idempotency_key,request_hash,state)
    VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,'in_progress')
    ON CONFLICT (organization_id,actor_user_id,operation,idempotency_key) DO NOTHING RETURNING id`,
  [input.organizationId,input.actorUserId,operation,input.idempotencyKey,input.requestHash]);
  const selected = await tx.query<ReceiptRow>(`SELECT request_hash,state,result_reference,response_hash
    FROM shared_idempotency_records WHERE organization_id=$1 AND actor_user_id=$2
      AND operation=$3 AND idempotency_key=$4 FOR UPDATE`,
  [input.organizationId,input.actorUserId,operation,input.idempotencyKey]);
  if (inserted.rowCount === 1) return null;
  const row = selected.rows[0];
  if (!row || row.request_hash !== input.requestHash || row.state !== "completed" ||
      !row.result_reference || !row.response_hash) conflict();
  const result = parseReference(row.result_reference);
  if (row.response_hash !== hashAcknowledgement(result)) unavailable();
  return result;
}
async function completeReceipt(tx: Db, input: { organizationId: string; actorUserId: string;
  idempotencyKey: string; requestHash: string }, operation: string, result: ReferralSourceAcknowledgement) {
  const reference = `${result.id}:${result.recordVersion}`;
  const completed = await tx.query(`UPDATE shared_idempotency_records SET state='completed',
    result_reference=$5,response_hash=$6,record_version=record_version+1,updated_at=transaction_timestamp()
    WHERE organization_id=$1 AND actor_user_id=$2 AND operation=$3 AND idempotency_key=$4
      AND request_hash=$7 AND state='in_progress'`,
  [input.organizationId,input.actorUserId,operation,input.idempotencyKey,reference,
    hashAcknowledgement(result),input.requestHash]);
  if (completed.rowCount !== 1) unavailable();
}
function parseReference(value: string): ReferralSourceAcknowledgement {
  const match = REFERENCE.exec(value); if (!match) unavailable();
  return Object.freeze({ id: match[1]!, recordVersion: version(match[2]!) });
}
function hashAcknowledgement(value: ReferralSourceAcknowledgement) {
  return hashRequestPayload({ id: value.id, record_version: value.recordVersion });
}
function view(row: SourceRow): ReferralSourceView { return Object.freeze({ id: row.id,
  displayName: row.display_name, sourceType: row.source_type, status: row.status,
  recordVersion: version(row.record_version) }); }
function ack(row: SourceRow): ReferralSourceAcknowledgement {
  return Object.freeze({ id: row.id, recordVersion: version(row.record_version) });
}
function version(value: number | string) { const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 1) unavailable(); return number; }
function forbidden(): never { throw new ReferralSourceError("REFERRAL_SOURCE_FORBIDDEN"); }
function notFound(): never { throw new ReferralSourceError("REFERRAL_SOURCE_NOT_FOUND"); }
function stale(): never { throw new ReferralSourceError("REFERRAL_SOURCE_STALE"); }
function conflict(): never { throw new ReferralSourceError("REFERRAL_SOURCE_CONFLICT"); }
function unavailable(): never { throw new ReferralSourceError("REFERRAL_SOURCE_UNAVAILABLE"); }
interface Db { query<Row extends Record<string, unknown> = Record<string, unknown>>(text: string,
  values?: readonly unknown[]): Promise<{ rows: readonly Row[]; rowCount: number }> }
function adapt(tx: TenantTransaction): Db { return Object.freeze({ async query<Row extends Record<string, unknown>>(
  text: string, values?: readonly unknown[]) { const result = await tx.query<Row>({ text, values });
  return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length }; } }); }
