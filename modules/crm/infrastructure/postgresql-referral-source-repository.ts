import "server-only";

import { appendAtomicMutationEffects } from "../../audit/server.ts";
import { hashRequestPayload } from "../../shared/public.ts";
import type { TenantTransaction, TenantTransactionRunner } from "../../shared/server.ts";
import { IdempotencyExecutionError, runIdempotentTransaction } from "../../shared/server.ts";
import {
  ReferralSourceError,
  isReferralSourceError,
  type ReferralSourceAcknowledgement,
  type ReferralSourceRepository,
  type ReferralSourceStatus,
  type ReferralSourceType,
  type ReferralSourceView,
} from "../application/referral-source-service.ts";
import type { ReferralSourceCursor } from "../domain/referral-source-cursor.ts";
import { validateReferralSourceDescription } from "../domain/approved-p2-contract.ts";

const CREATE_OPERATION = "crm.referral_source.create";
const UPDATE_OPERATION = "crm.referral_source.update";
const DEACTIVATE_OPERATION = "crm.referral_source.deactivate";
const REFERENCE = /^rs:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):(active|inactive):([1-9][0-9]{0,15}):(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/;

interface SourceRow extends Record<string, unknown> {
  id: string; display_name: string; source_type: ReferralSourceType;
  description: string | null;
  status: ReferralSourceStatus; record_version: number | string;
  updated_at: Date | string;
  deactivated_at?: Date | string | null;
  deactivated_by_user_id?: string | null;
  deactivate_reason_code?: string | null;
}
type ReferralSourceMutationInput = {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly actorRole: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly effects: Parameters<typeof appendAtomicMutationEffects>[1];
  readonly idempotencyRecordId: string;
  readonly occurredAt: string;
  readonly requestId: string;
};

export class PostgresqlReferralSourceRepository implements ReferralSourceRepository {
  private readonly runner: TenantTransactionRunner;
  constructor(runner: TenantTransactionRunner) { this.runner = runner; }

  list(input: Parameters<ReferralSourceRepository["list"]>[0]) {
    return this.run(input, async (tx) => {
      await assertActor(tx, input, "read");
      const result = await tx.query<SourceRow>(`SELECT id,display_name,source_type,description,status,record_version,updated_at
        FROM crm_referral_sources
        WHERE organization_id=$1
          AND ($2::text IS NULL OR status=$2)
          AND ($3::text IS NULL OR source_type=$3)
          AND ($4::text IS NULL OR display_name ILIKE '%' || $4 || '%')
          AND ($5::text IS NULL OR display_name COLLATE "C" > $5 OR
            (display_name COLLATE "C" = $5 AND id::text COLLATE "C" > $6))
        ORDER BY display_name COLLATE "C" ASC,id::text COLLATE "C" ASC
        LIMIT $7`,
      [input.organizationId, input.status, input.sourceType, input.query,
        input.cursor?.displayName ?? null, input.cursor?.id ?? null, input.limit + 1]);
      const rows = result.rows.map(view);
      return Object.freeze({ items: Object.freeze(rows.slice(0, input.limit)), hasMore: rows.length > input.limit });
    });
  }

  find(input: Parameters<ReferralSourceRepository["find"]>[0]) {
    return this.run(input, async (tx) => {
      await assertActor(tx, input, "read");
      const result = await tx.query<SourceRow>(`SELECT id,display_name,source_type,description,status,record_version,updated_at
        FROM crm_referral_sources
        WHERE organization_id=$1 AND id=$2
          AND ($3::text <> 'advisor' OR status='active')`, [input.organizationId, input.sourceId, input.actorRole]);
      if (!result.rows[0] || (input.actorRole === "advisor" && result.rows[0].status !== "active")) return null;
      return view(result.rows[0]);
    });
  }

  create(input: Parameters<ReferralSourceRepository["create"]>[0]) {
    return this.mutate(input, CREATE_OPERATION, async (tx) => {
      const result = await tx.query<SourceRow>(`INSERT INTO crm_referral_sources
        (id,organization_id,display_name,source_type,description,status,record_version)
        VALUES ($1,$2,$3,$4,$5,'active',1)
        RETURNING id,display_name,source_type,description,status,record_version,updated_at`,
      [input.sourceId, input.organizationId, input.displayName, input.sourceType, input.description]);
      const row = result.rows[0];
      if (!row || row.id !== input.sourceId || row.status !== "active" || version(row.record_version) !== 1) unavailable();
      return ack(row);
    });
  }

  update(input: Parameters<ReferralSourceRepository["update"]>[0]) {
    return this.mutate(input, UPDATE_OPERATION, async (tx) => {
      const locked = await tx.query<SourceRow>(`SELECT id,display_name,source_type,description,status,record_version,updated_at
        FROM crm_referral_sources WHERE organization_id=$1 AND id=$2 FOR UPDATE`, [input.organizationId, input.sourceId]);
      const current = locked.rows[0]; if (!current) notFound();
      if (version(current.record_version) !== input.expectedRecordVersion) stale();
      if (!validateReferralSourceDescription({ sourceType: input.sourceType, description: input.description })) unavailable();
      if (current.status === "inactive") conflict();
      if (current.display_name === input.displayName && current.source_type === input.sourceType &&
          current.description === input.description) conflict();
      const updated = await tx.query<SourceRow>(`UPDATE crm_referral_sources
        SET display_name=$3,source_type=$4,description=$5,record_version=record_version+1,updated_at=transaction_timestamp()
        WHERE organization_id=$1 AND id=$2 AND record_version=$6 AND status='active'
        RETURNING id,display_name,source_type,description,status,record_version,updated_at`,
      [input.organizationId, input.sourceId, input.displayName, input.sourceType, input.description,
        input.expectedRecordVersion]);
      const row = updated.rows[0]; if (!row) stale();
      if (row.id !== input.sourceId || row.status !== "active" || row.source_type !== input.sourceType ||
          version(row.record_version) !== input.expectedRecordVersion + 1) unavailable();
      return ack(row);
    });
  }

  deactivate(input: Parameters<ReferralSourceRepository["deactivate"]>[0]) {
    return this.mutate(input, DEACTIVATE_OPERATION, async (tx) => {
      const locked = await tx.query<SourceRow>(`SELECT id,status,record_version
        FROM crm_referral_sources
        WHERE organization_id=$1 AND id=$2
        FOR UPDATE`, [input.organizationId, input.sourceId]);
      const current = locked.rows[0];
      if (!current) notFound();
      if (current.status === "inactive") conflict();
      if (version(current.record_version) !== input.expectedRecordVersion) stale();
      const updated = await tx.query<SourceRow>(`UPDATE crm_referral_sources
        SET status='inactive', deactivated_at=transaction_timestamp(), deactivated_by_user_id=$3,
            deactivate_reason_code=$4, record_version=record_version+1, updated_at=transaction_timestamp()
        WHERE organization_id=$1 AND id=$2 AND status='active' AND record_version=$5
        RETURNING id,display_name,source_type,description,status,record_version,updated_at`,
      [input.organizationId, input.sourceId, input.actorUserId, input.reasonCode, input.expectedRecordVersion]);
      const row = updated.rows[0];
      if (!row) stale();
      if (row.id !== input.sourceId || row.status !== "inactive" ||
          version(row.record_version) !== input.expectedRecordVersion + 1) unavailable();
      return ack(row);
    });
  }

  private mutate(
    input: ReferralSourceMutationInput,
    operation: string,
    execute: (tx: Db) => Promise<ReferralSourceAcknowledgement>,
  ): Promise<ReferralSourceAcknowledgement> {
    return runIdempotentTransaction({
      runner: this.runner,
      context: {
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        actorKind: "user",
        actorOpaqueId: input.actorUserId,
        requestId: input.requestId,
      },
      claim: {
        id: input.idempotencyRecordId,
        organizationId: input.organizationId,
        actorKind: "user",
        actorOpaqueId: input.actorUserId,
        operation,
        key: input.idempotencyKey,
        requestHash: input.requestHash,
        createdAt: input.occurredAt,
      },
      revalidate: (transaction) => assertActor(adapt(transaction), input, "manage"),
      execute: async (transaction) => {
        const acknowledgement = await execute(adapt(transaction));
        await appendAtomicMutationEffects(adapt(transaction), input.effects);
        return {
          state: "completed" as const,
          resultReference: encodeReference(acknowledgement),
          responseHash: hashAcknowledgement(acknowledgement),
          updatedAt: input.occurredAt,
          value: acknowledgement,
        };
      },
    }).then((result) => {
      if (result.status === "executed") return result.value;
      const acknowledgement = parseReference(result.resultReference);
      if (result.responseHash !== hashAcknowledgement(acknowledgement)) unavailable();
      return acknowledgement;
    }).catch((cause) => {
      if (isReferralSourceError(cause)) throw cause;
      if (cause instanceof IdempotencyExecutionError) {
        if (cause.code === "IDEMPOTENCY_KEY_REUSED") conflict();
        if (cause.code === "IDEMPOTENCY_IN_PROGRESS") throw new ReferralSourceError("REFERRAL_SOURCE_CONFLICT");
      }
      unavailable();
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
  const roles = mode === "read" ? ["founder", "advisor"] : ["founder"];
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
function parseReference(value: string): ReferralSourceAcknowledgement {
  const match = REFERENCE.exec(value);
  if (!match) unavailable();
  const id = match[1]!.toLowerCase();
  const status = match[2] as ReferralSourceStatus;
  const recordVersion = version(match[3]!);
  const updatedAt = match[4]!;
  const result = Object.freeze({ id, status, recordVersion, updatedAt });
  if (encodeReference(result) !== value) unavailable();
  return result;
}
function hashAcknowledgement(value: ReferralSourceAcknowledgement) {
  return hashRequestPayload({
    referral_source: {
      id: value.id,
      status: value.status,
      record_version: value.recordVersion,
      updated_at: value.updatedAt,
    },
  });
}
function encodeReference(value: ReferralSourceAcknowledgement): string {
  const reference = `rs:${value.id.toLowerCase()}:${value.status}:${value.recordVersion}:${value.updatedAt}`;
  if (reference.length > 128 || !REFERENCE.test(reference)) unavailable();
  return reference;
}
function view(row: SourceRow): ReferralSourceView { return Object.freeze({ id: row.id,
  displayName: row.display_name, sourceType: row.source_type, description: row.description,
  status: row.status,
  recordVersion: version(row.record_version), updatedAt: new Date(row.updated_at).toISOString() }); }
function ack(row: SourceRow): ReferralSourceAcknowledgement {
  return Object.freeze({ id: row.id, status: row.status, recordVersion: version(row.record_version), updatedAt: new Date(row.updated_at).toISOString() });
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
