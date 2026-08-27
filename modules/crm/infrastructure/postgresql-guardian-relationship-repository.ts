import "server-only";

import { appendAtomicMutationEffects } from "../../audit/server.ts";
import { IdempotencyExecutionError, runIdempotentTransaction } from "../../shared/server.ts";
import { hashRequestPayload } from "../../shared/public.ts";
import type { TenantTransaction, TenantTransactionRunner } from "../../shared/server.ts";
import {
  GuardianRelationshipError,
  type GuardianContactHint,
  type GuardianRelationshipRepository,
  type EndGuardianRelationshipResult,
  type GuardianRelationshipResult,
  type GuardianRelationshipsView,
  type PrimaryGuardianHandoffResult,
} from "../application/guardian-relationship-service.ts";
import type { PrimaryGuardianRelationshipType } from "../domain/contract.ts";

const ATTACH_OPERATION = "crm.attach_student_guardian";
const HANDOFF_OPERATION = "crm.handoff_student_primary_guardian";
const END_OPERATION = "crm.end_student_guardian_relationship";
const POSTGRES_SEVERITIES = new Set([
  "ERROR", "FATAL", "PANIC", "WARNING", "NOTICE", "DEBUG", "INFO", "LOG",
]);
const CONCURRENCY_POSTGRES_CODES = new Set(["40001", "40P01", "55P03", "57014"]);

type ConcurrencyPostgresCode = "40001" | "40P01" | "55P03" | "57014";
type PostgresFailureReporter = (evidence: Readonly<{ postgresCode: ConcurrencyPostgresCode }>) => void;

interface RelationshipRow extends Record<string, unknown> {
  relationship_id: string;
  student_id: string;
  guardian_id: string;
  relationship_type: PrimaryGuardianRelationshipType;
  relationship_description: string | null;
  is_legal_guardian: boolean;
  is_primary_contact: boolean;
  is_emergency_contact: boolean;
  is_billing_contact: boolean;
  notification_consent: boolean;
  starts_at: Date | string;
  ends_at?: Date | string | null;
  record_version: string | number;
}

interface CurrentRelationshipRow extends RelationshipRow {
  student_display_name: string;
  guardian_display_name: string;
  email_hint: string | null;
  phone_hint: string | null;
}

interface LockedRelationshipRow extends RelationshipRow {
  guardian_status: string;
}

interface ReceiptRow extends Record<string, unknown> {
  request_hash: string;
  state: string;
  result_reference: string | null;
}

export class PostgresqlGuardianRelationshipRepository implements GuardianRelationshipRepository {
  private readonly runner: TenantTransactionRunner;
  private readonly reportPostgresFailure: PostgresFailureReporter;

  constructor(
    runner: TenantTransactionRunner,
    reportPostgresFailure: PostgresFailureReporter = writeSafePostgresFailure,
  ) {
    this.runner = runner;
    this.reportPostgresFailure = reportPostgresFailure;
  }

  listCurrent(input: Parameters<GuardianRelationshipRepository["listCurrent"]>[0]) {
    return this.run(input, (transaction) => listCurrent(transaction, input.studentId));
  }
  listHistory(input: Parameters<GuardianRelationshipRepository["listHistory"]>[0]) { return this.run(input, tx => listHistory(tx, input.organizationId, input.studentId)); }

  endRelationship(input: Parameters<GuardianRelationshipRepository["endRelationship"]>[0]): Promise<EndGuardianRelationshipResult> {
    const context = {
      organizationId: input.organizationId,
      actorKind: "user" as const,
      actorOpaqueId: input.actorUserId,
      actorUserId: input.actorUserId,
      requestId: input.command.requestId,
    };
    return runIdempotentTransaction({
      runner: this.runner,
      context,
      claim: {
        id: input.idempotencyRecordId, organizationId: input.organizationId,
        actorKind: "user", actorOpaqueId: input.actorUserId, operation: END_OPERATION,
        key: input.command.idempotencyKey, requestHash: input.requestHash, createdAt: input.occurredAt,
      },
      revalidate: (transaction) => assertActiveGuardianManager(adaptTransaction(transaction), input.organizationId, input.actorUserId),
      execute: async (transaction) => {
        const value = await endRelationshipInTransaction(transaction, input);
        await appendAtomicMutationEffects(adaptTransaction(transaction), input.effects);
        return {
          state: "completed" as const, resultReference: value.relationshipId,
          responseHash: hashRequestPayload(endReceiptJson(value)), updatedAt: input.occurredAt, value,
        };
      },
    }).then(async (result) => {
      if (result.status === "executed") return result.value;
      return this.runner.run(context, async (transaction) => {
        const value = await selectEndedRelationship(transaction, input);
        if (!value || value.relationshipId !== result.resultReference ||
            hashRequestPayload(endReceiptJson(value)) !== result.responseHash) {
          throw error("GUARDIAN_RELATIONSHIP_UNAVAILABLE");
        }
        return value;
      });
    }).catch((cause) => {
      if (cause instanceof IdempotencyExecutionError) {
        throw error(cause.code === "IDEMPOTENCY_IN_PROGRESS"
          ? "GUARDIAN_RELATIONSHIP_IDEMPOTENCY_IN_PROGRESS"
          : cause.code === "IDEMPOTENCY_KEY_REUSED"
            ? "GUARDIAN_RELATIONSHIP_IDEMPOTENCY_KEY_REUSED"
            : "GUARDIAN_RELATIONSHIP_UNAVAILABLE");
      }
      if (cause instanceof GuardianRelationshipError) throw cause;
      const postgresCode = readConcurrencyPostgresCode(cause);
      if (postgresCode) this.reportPostgresFailure(Object.freeze({ postgresCode }));
      throw error("GUARDIAN_RELATIONSHIP_UNAVAILABLE");
    });
  }

  searchGuardians(input: Parameters<GuardianRelationshipRepository["searchGuardians"]>[0]) {
    return this.run(input, async (transaction) => {
      await assertActiveGuardianManager(transaction, input.organizationId, input.actorUserId);
      const student = await lockActiveStudent(transaction, input.studentId, false);
      if (!student) return null;
      const result = await transaction.query<GuardianHintRow>(
        `SELECT guardian.id, guardian.display_name,
                CASE
                  WHEN guardian.email IS NULL THEN NULL
                  WHEN position('@' IN guardian.email) > 1
                    THEN left(guardian.email, 1) || '***@' || split_part(guardian.email, '@', 2)
                  ELSE '***'
                END AS email_hint,
                CASE
                  WHEN guardian.phone IS NULL THEN NULL
                  WHEN length(guardian.phone) <= 4 THEN repeat('*', length(guardian.phone))
                  ELSE repeat('*', length(guardian.phone) - 4) || right(guardian.phone, 4)
                END AS phone_hint
           FROM crm_guardians AS guardian
          WHERE guardian.status = 'active'
            AND (position(lower($2) IN lower(guardian.display_name)) > 0
              OR position(lower($2) IN lower(coalesce(guardian.email, ''))) > 0
              OR position(lower($2) IN lower(coalesce(guardian.phone, ''))) > 0)
            AND NOT EXISTS (
              SELECT 1 FROM crm_student_guardian_relationships AS relationship
               WHERE relationship.student_id = $1
                 AND relationship.guardian_id = guardian.id
                 AND relationship.ends_at IS NULL
            )
          ORDER BY lower(guardian.display_name) COLLATE "C", guardian.id
          LIMIT 20`,
        [input.studentId, input.query],
      );
      return Object.freeze(result.rows.map(toGuardianHint));
    });
  }

  createRelationship(input: Parameters<GuardianRelationshipRepository["createRelationship"]>[0]) {
    return this.run(input, async (transaction) => {
      const receipt = await claimReceipt(transaction, input, ATTACH_OPERATION);
      await assertActiveGuardianManager(transaction, input.organizationId, input.actorUserId);
      if (receipt.replayReference) {
        const replay = await selectRelationship(transaction, receipt.replayReference);
        if (!replay) throw error("GUARDIAN_RELATIONSHIP_IDEMPOTENCY_IN_PROGRESS");
        return replay;
      }
      if (!await lockActiveStudent(transaction, input.studentId, true)) {
        throw error("GUARDIAN_RELATIONSHIP_STUDENT_NOT_FOUND");
      }
      if (!await lockActiveGuardian(transaction, input.guardianId)) {
        throw error("GUARDIAN_RELATIONSHIP_GUARDIAN_NOT_FOUND");
      }
      const pair = await transaction.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM crm_student_guardian_relationships
            WHERE student_id = $1 AND guardian_id = $2 AND ends_at IS NULL
         ) AS exists`,
        [input.studentId, input.guardianId],
      );
      if (pair.rows[0]?.exists) throw error("GUARDIAN_RELATIONSHIP_CURRENT_PAIR_EXISTS");
      const inserted = await transaction.query<RelationshipRow>(
        `INSERT INTO crm_student_guardian_relationships
          (id, organization_id, student_id, guardian_id, relationship_type, relationship_description,
           is_legal_guardian, is_primary_contact, is_emergency_contact,
           is_billing_contact, notification_consent, starts_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,false,$8,$9,$10,transaction_timestamp())
         RETURNING id AS relationship_id, student_id, guardian_id, relationship_type, relationship_description,
                   is_legal_guardian, is_primary_contact, is_emergency_contact,
                   is_billing_contact, notification_consent, starts_at, record_version`,
        [input.relationshipId, input.organizationId, input.studentId, input.guardianId,
          input.relationshipType, input.relationshipDescription, input.isLegalGuardian, input.isEmergencyContact,
          input.isBillingContact, input.notificationConsent],
      );
      const relationship = inserted.rows[0];
      if (!relationship) throw error("GUARDIAN_RELATIONSHIP_UNAVAILABLE");
      await appendAtomicMutationEffects(transaction, input.effects);
      await completeReceipt(transaction, input, ATTACH_OPERATION, input.relationshipId);
      return toRelationship(relationship);
    });
  }

  handoffPrimaryContact(input: Parameters<GuardianRelationshipRepository["handoffPrimaryContact"]>[0]) {
    return this.run(input, async (transaction) => {
      const receipt = await claimReceipt(transaction, input, HANDOFF_OPERATION);
      await assertActiveGuardianManager(transaction, input.organizationId, input.actorUserId);
      if (receipt.replayReference) {
        const replay = await selectHandoff(transaction, receipt.replayReference);
        if (!replay) throw error("GUARDIAN_RELATIONSHIP_IDEMPOTENCY_IN_PROGRESS");
        return replay;
      }
      if (!await lockActiveStudent(transaction, input.studentId, true)) {
        throw error("GUARDIAN_RELATIONSHIP_STUDENT_NOT_FOUND");
      }
      const locked = await transaction.query<LockedRelationshipRow>(
        `SELECT relationship.id AS relationship_id, relationship.student_id,
                relationship.guardian_id, relationship.relationship_type, relationship.relationship_description,
                relationship.is_legal_guardian, relationship.is_primary_contact,
                relationship.is_emergency_contact, relationship.is_billing_contact,
                relationship.notification_consent, relationship.starts_at,
                relationship.record_version, guardian.status AS guardian_status
           FROM crm_student_guardian_relationships AS relationship
           JOIN crm_guardians AS guardian ON guardian.id = relationship.guardian_id
          WHERE relationship.student_id = $1 AND relationship.ends_at IS NULL
          ORDER BY relationship.id
          FOR UPDATE OF relationship, guardian`,
        [input.studentId],
      );
      const primary = locked.rows.find((row) => row.is_primary_contact);
      const successor = locked.rows.find((row) =>
        !row.is_primary_contact && row.guardian_id === input.successorGuardianId);
      if (!primary) throw error("GUARDIAN_RELATIONSHIP_PRIMARY_REQUIRED");
      if (toVersion(primary.record_version) !== input.expectedPrimaryRecordVersion) {
        throw error("GUARDIAN_RELATIONSHIP_STALE_VERSION");
      }
      if (!successor || successor.guardian_status !== "active") {
        throw error("GUARDIAN_RELATIONSHIP_GUARDIAN_NOT_FOUND");
      }
      const closedAt = await transaction.query<{ closed_at: Date | string }>(
        "SELECT clock_timestamp() AS closed_at",
      );
      const timestamp = closedAt.rows[0]?.closed_at;
      if (!timestamp) throw error("GUARDIAN_RELATIONSHIP_UNAVAILABLE");
      const closed = await transaction.query(
        `UPDATE crm_student_guardian_relationships
            SET ends_at = $3, ended_by_user_id = $4, end_reason_code = $5,
                record_version = record_version + 1, updated_at = $3
          WHERE student_id = $1 AND id = ANY($2::uuid[]) AND ends_at IS NULL`,
        [input.studentId, [primary.relationship_id, successor.relationship_id], timestamp,
          input.actorUserId, input.reason],
      );
      if (closed.rowCount !== 2) throw error("GUARDIAN_RELATIONSHIP_STALE_VERSION");
      const nextVersion = input.expectedPrimaryRecordVersion + 1;
      const inserted = await transaction.query<RelationshipRow>(
        `INSERT INTO crm_student_guardian_relationships
          (id, organization_id, student_id, guardian_id, relationship_type, relationship_description,
           is_legal_guardian, is_primary_contact, is_emergency_contact,
           is_billing_contact, notification_consent, starts_at, record_version,
           created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,true,$8,$9,$10,$11,$12,$11,$11)
         RETURNING id AS relationship_id, student_id, guardian_id, relationship_type, relationship_description,
                   is_legal_guardian, is_primary_contact, is_emergency_contact,
                   is_billing_contact, notification_consent, starts_at, record_version`,
        [input.relationshipId, input.organizationId, input.studentId, successor.guardian_id,
          successor.relationship_type, successor.relationship_description, successor.is_legal_guardian,
          successor.is_emergency_contact, successor.is_billing_contact,
          successor.notification_consent, timestamp, nextVersion],
      );
      const relationship = inserted.rows[0];
      if (!relationship) throw error("GUARDIAN_RELATIONSHIP_UNAVAILABLE");
      await appendAtomicMutationEffects(transaction, input.effects);
      await completeReceipt(transaction, input, HANDOFF_OPERATION, input.relationshipId);
      return Object.freeze({
        relationship: toRelationship(relationship),
        closedRelationshipIds: Object.freeze({
          previousPrimary: primary.relationship_id,
          successorSecondary: successor.relationship_id,
        }),
      });
    });
  }

  private run<Result>(
    input: { readonly organizationId: string; readonly actorUserId: string },
    operation: (transaction: CrmTransaction) => Promise<Result>,
  ): Promise<Result> {
    return this.runner.run({ organizationId: input.organizationId, actorUserId: input.actorUserId }, async (tenantTransaction) => {
      try {
        return await operation(adaptTransaction(tenantTransaction));
      } catch (cause) {
        if (cause instanceof GuardianRelationshipError) throw cause;
        const postgresCode = readConcurrencyPostgresCode(cause);
        if (postgresCode) this.reportPostgresFailure(Object.freeze({ postgresCode }));
        throw mapPostgresError(cause);
      }
    });
  }
}

interface GuardianHintRow extends Record<string, unknown> {
  id: string;
  display_name: string;
  email_hint: string | null;
  phone_hint: string | null;
}

async function listCurrent(
  transaction: CrmTransaction,
  studentId: string,
): Promise<GuardianRelationshipsView | null> {
  const student = await transaction.query<{ id: string; display_name: string }>(
    `SELECT id, display_name
       FROM crm_students
      WHERE id = $1 AND status IN ('active', 'pending_delete')`,
    [studentId],
  );
  const studentRow = student.rows[0];
  if (!studentRow) return null;
  const relationships = await transaction.query<CurrentRelationshipRow>(
    `SELECT relationship.id AS relationship_id, relationship.student_id,
            relationship.guardian_id, relationship.relationship_type, relationship.relationship_description,
            relationship.is_legal_guardian, relationship.is_primary_contact,
            relationship.is_emergency_contact, relationship.is_billing_contact,
            relationship.notification_consent, relationship.starts_at,
            relationship.record_version, $2::text AS student_display_name,
            guardian.display_name AS guardian_display_name,
            CASE
              WHEN guardian.email IS NULL THEN NULL
              WHEN position('@' IN guardian.email) > 1
                THEN left(guardian.email, 1) || '***@' || split_part(guardian.email, '@', 2)
              ELSE '***'
            END AS email_hint,
            CASE
              WHEN guardian.phone IS NULL THEN NULL
              WHEN length(guardian.phone) <= 4 THEN repeat('*', length(guardian.phone))
              ELSE repeat('*', length(guardian.phone) - 4) || right(guardian.phone, 4)
            END AS phone_hint
       FROM crm_student_guardian_relationships AS relationship
       JOIN crm_guardians AS guardian ON guardian.id = relationship.guardian_id
      WHERE relationship.student_id = $1 AND relationship.ends_at IS NULL
        AND guardian.status IN ('active', 'pending_delete')
      ORDER BY relationship.is_primary_contact DESC, relationship.starts_at, relationship.id`,
    [studentId, studentRow.display_name],
  );
  return Object.freeze({
    student: Object.freeze({ id: studentRow.id, displayName: studentRow.display_name }),
    relationships: Object.freeze(relationships.rows.map((row) => Object.freeze({
      relationship: toRelationship(row),
      guardian: toGuardianHint({
        id: row.guardian_id,
        display_name: row.guardian_display_name,
        email_hint: row.email_hint,
        phone_hint: row.phone_hint,
      }),
    }))),
  });
}

async function listHistory(transaction: CrmTransaction, organizationId: string, studentId: string): Promise<GuardianRelationshipsView | null> {
  const student = await transaction.query<{id:string;display_name:string}>(`SELECT id,display_name FROM crm_students WHERE id=$1 AND organization_id=$2 AND status IN ('active','pending_delete')`, [studentId, organizationId]);
  if (!student.rows[0]) return null;
  const rows = await transaction.query<CurrentRelationshipRow>(`SELECT relationship.id AS relationship_id,relationship.student_id,relationship.guardian_id,relationship.relationship_type,relationship.relationship_description,relationship.is_legal_guardian,relationship.is_primary_contact,relationship.is_emergency_contact,relationship.is_billing_contact,relationship.notification_consent,relationship.starts_at,relationship.ends_at,relationship.record_version,CASE WHEN guardian.status='deleted' THEN 'Deleted guardian' ELSE guardian.display_name END AS guardian_display_name,NULL::text AS email_hint,NULL::text AS phone_hint FROM crm_student_guardian_relationships relationship JOIN crm_guardians guardian ON guardian.id=relationship.guardian_id AND guardian.organization_id=relationship.organization_id JOIN crm_students student ON student.id=relationship.student_id AND student.organization_id=relationship.organization_id WHERE relationship.student_id=$1 AND relationship.organization_id=$2 AND student.status IN ('active','pending_delete') ORDER BY relationship.starts_at DESC,relationship.id DESC`, [studentId, organizationId]);
  return {student:{id:student.rows[0].id,displayName:student.rows[0].display_name},relationships:rows.rows.map(row=>({relationship:toRelationship(row),guardian:toGuardianHint({id:row.guardian_id,display_name:row.guardian_display_name,email_hint:row.email_hint,phone_hint:row.phone_hint})}))};
}

interface EndRelationshipRow extends Record<string, unknown> {
  relationship_id: string;
  student_id: string;
  is_primary_contact: boolean;
  ends_at: Date | string | null;
  record_version: number | string;
}

async function endRelationshipInTransaction(
  transaction: TenantTransaction,
  input: Parameters<GuardianRelationshipRepository["endRelationship"]>[0],
): Promise<EndGuardianRelationshipResult> {
  const student = await transaction.query<{ id: string }>({ text: `SELECT id FROM crm_students WHERE organization_id=$1 AND id=$2 AND status IN ('active','pending_delete') FOR UPDATE`, values: [input.organizationId, input.command.studentId] });
  if (student.rows.length === 0) throw error("GUARDIAN_RELATIONSHIP_STUDENT_NOT_FOUND");
  const locked = await transaction.query<EndRelationshipRow>({ text: `SELECT id AS relationship_id, student_id, is_primary_contact, ends_at, record_version FROM crm_student_guardian_relationships WHERE organization_id=$1 AND student_id=$2 AND id=$3 AND ends_at IS NULL FOR UPDATE`, values: [input.organizationId, input.command.studentId, input.command.relationshipId] });
  const relationship = locked.rows[0];
  if (!relationship) throw error("GUARDIAN_RELATIONSHIP_NOT_FOUND");
  if (toVersion(relationship.record_version) !== input.command.expectedRecordVersion) throw error("GUARDIAN_RELATIONSHIP_STALE_VERSION");
  if (relationship.is_primary_contact) throw error("GUARDIAN_RELATIONSHIP_PRIMARY_CANNOT_END");
  const updated = await transaction.query<EndRelationshipRow>({ text: `UPDATE crm_student_guardian_relationships SET ends_at=$6, updated_at=$6, ended_by_user_id=$4, end_reason_code=$5, record_version=record_version+1 WHERE organization_id=$1 AND student_id=$2 AND id=$3 AND ends_at IS NULL AND record_version=$7 RETURNING id AS relationship_id, student_id, is_primary_contact, ends_at, record_version`, values: [input.organizationId, input.command.studentId, input.command.relationshipId, input.actorUserId, input.reason, input.occurredAt, input.command.expectedRecordVersion] });
  if (updated.rows.length !== 1) throw error("GUARDIAN_RELATIONSHIP_STALE_VERSION");
  return toEndResult(updated.rows[0]!, input.occurredAt);
}

async function selectEndedRelationship(transaction: TenantTransaction, input: Parameters<GuardianRelationshipRepository["endRelationship"]>[0]): Promise<EndGuardianRelationshipResult | null> {
  const result = await transaction.query<EndRelationshipRow>({ text: `SELECT id AS relationship_id, student_id, is_primary_contact, ends_at, record_version FROM crm_student_guardian_relationships WHERE organization_id=$1 AND student_id=$2 AND id=$3 AND ends_at IS NOT NULL`, values: [input.organizationId, input.command.studentId, input.command.relationshipId] });
  return result.rows[0] ? toEndResult(result.rows[0], input.occurredAt) : null;
}

function toEndResult(row: EndRelationshipRow, occurredAt: string): EndGuardianRelationshipResult {
  if (row.ends_at === null) throw error("GUARDIAN_RELATIONSHIP_UNAVAILABLE");
  const endedAt = toIso(row.ends_at);
  return Object.freeze({ relationshipId: row.relationship_id, studentId: row.student_id, status: "ended" as const, endsAt: endedAt, recordVersion: toVersion(row.record_version), occurredAt: endedAt });
}

function endReceiptJson(value: EndGuardianRelationshipResult) {
  return { relationship_id: value.relationshipId, student_id: value.studentId, status: value.status, ends_at: value.endsAt, record_version: value.recordVersion, occurred_at: value.occurredAt };
}

async function assertActiveGuardianManager(
  transaction: CrmTransaction,
  organizationId: string,
  actorUserId: string,
): Promise<void> {
  const result = await transaction.query<{ binding_id: string }>(
    `SELECT binding.id AS binding_id
       FROM identity_users AS actor
       JOIN access_organization_memberships AS membership
         ON membership.user_id = actor.id AND membership.organization_id = $1
       JOIN access_role_bindings AS binding
         ON binding.membership_id = membership.id AND binding.organization_id = $1
        AND binding.user_id = actor.id
       JOIN access_organizations AS organization ON organization.id = membership.organization_id
      WHERE actor.id = $2 AND actor.status = 'active'
        AND organization.status = 'active' AND membership.status = 'active'
        AND binding.status = 'active' AND binding.role IN ('founder','advisor')
      FOR SHARE OF actor, membership, binding, organization`,
    [organizationId, actorUserId],
  );
  if (result.rows.length === 0) throw error("GUARDIAN_RELATIONSHIP_FORBIDDEN");
}

async function lockActiveStudent(
  transaction: CrmTransaction,
  studentId: string,
  lock: boolean,
): Promise<boolean> {
  const result = await transaction.query<{ id: string }>(
    `SELECT id FROM crm_students WHERE id = $1 AND status = 'active'${lock ? " FOR UPDATE" : ""}`,
    [studentId],
  );
  return result.rows.length === 1;
}

async function lockActiveGuardian(transaction: CrmTransaction, guardianId: string): Promise<boolean> {
  const result = await transaction.query<{ id: string }>(
    "SELECT id FROM crm_guardians WHERE id = $1 AND status = 'active' FOR UPDATE",
    [guardianId],
  );
  return result.rows.length === 1;
}

async function claimReceipt(
  transaction: CrmTransaction,
  input: { readonly organizationId: string; readonly actorUserId: string;
    readonly idempotencyKey: string; readonly requestHash: string },
  operation: string,
): Promise<{ readonly replayReference: string | null }> {
  const claim = await transaction.query(
    `INSERT INTO shared_idempotency_records
      (id, organization_id, actor_user_id, operation, idempotency_key, request_hash, state)
     VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,'in_progress')
     ON CONFLICT (organization_id, actor_user_id, operation, idempotency_key) DO NOTHING
     RETURNING id`,
    [input.organizationId, input.actorUserId, operation, input.idempotencyKey, input.requestHash],
  );
  const result = await transaction.query<ReceiptRow>(
    `SELECT request_hash, state, result_reference
       FROM shared_idempotency_records
      WHERE organization_id = $1 AND actor_user_id = $2
        AND operation = $3 AND idempotency_key = $4
      FOR UPDATE`,
    [input.organizationId, input.actorUserId, operation, input.idempotencyKey],
  );
  if (claim.rowCount === 1) return Object.freeze({ replayReference: null });
  const receipt = result.rows[0];
  if (!receipt || receipt.request_hash !== input.requestHash) {
    throw error("GUARDIAN_RELATIONSHIP_IDEMPOTENCY_KEY_REUSED");
  }
  if (receipt.state !== "completed" || !receipt.result_reference) {
    throw error("GUARDIAN_RELATIONSHIP_IDEMPOTENCY_IN_PROGRESS");
  }
  return Object.freeze({ replayReference: receipt.result_reference });
}

async function completeReceipt(
  transaction: CrmTransaction,
  input: { readonly organizationId: string; readonly actorUserId: string;
    readonly idempotencyKey: string; readonly requestHash: string },
  operation: string,
  resultReference: string,
): Promise<void> {
  const result = await transaction.query(
    `UPDATE shared_idempotency_records
        SET state = 'completed', result_reference = $5, response_hash = $6,
            record_version = record_version + 1, updated_at = transaction_timestamp()
      WHERE organization_id = $1 AND actor_user_id = $2
        AND operation = $3 AND idempotency_key = $4
        AND request_hash = $6 AND state = 'in_progress'`,
    [input.organizationId, input.actorUserId, operation, input.idempotencyKey,
      resultReference, input.requestHash],
  );
  if (result.rowCount !== 1) throw error("GUARDIAN_RELATIONSHIP_UNAVAILABLE");
}

async function selectRelationship(
  transaction: CrmTransaction,
  relationshipId: string,
): Promise<GuardianRelationshipResult | null> {
  const result = await transaction.query<RelationshipRow>(
    `SELECT id AS relationship_id, student_id, guardian_id, relationship_type, relationship_description,
            is_legal_guardian, is_primary_contact, is_emergency_contact,
            is_billing_contact, notification_consent, starts_at, record_version
       FROM crm_student_guardian_relationships WHERE id = $1`,
    [relationshipId],
  );
  return result.rows[0] ? toRelationship(result.rows[0]) : null;
}

async function selectHandoff(
  transaction: CrmTransaction,
  relationshipId: string,
): Promise<PrimaryGuardianHandoffResult | null> {
  const relationship = await selectRelationship(transaction, relationshipId);
  if (!relationship?.isPrimaryContact) return null;
  const result = await transaction.query<{ relationship_id: string; is_primary_contact: boolean }>(
    `SELECT id AS relationship_id, is_primary_contact
       FROM crm_student_guardian_relationships
      WHERE student_id = $1 AND ends_at = $2
        AND (is_primary_contact OR guardian_id = $3)
      ORDER BY is_primary_contact DESC`,
    [relationship.studentId, relationship.startsAt, relationship.guardianId],
  );
  const previous = result.rows.find((row) => row.is_primary_contact);
  const successor = result.rows.find((row) => !row.is_primary_contact);
  if (!previous || !successor) return null;
  return Object.freeze({
    relationship,
    closedRelationshipIds: Object.freeze({
      previousPrimary: previous.relationship_id,
      successorSecondary: successor.relationship_id,
    }),
  });
}

function toRelationship(row: RelationshipRow): GuardianRelationshipResult {
  return Object.freeze({
    relationshipId: row.relationship_id,
    studentId: row.student_id,
    guardianId: row.guardian_id,
    relationshipType: row.relationship_type,
    relationshipDescription: row.relationship_description,
    isLegalGuardian: row.is_legal_guardian,
    isPrimaryContact: row.is_primary_contact,
    isEmergencyContact: row.is_emergency_contact,
    isBillingContact: row.is_billing_contact,
    notificationConsent: row.notification_consent,
    startsAt: toIso(row.starts_at),
    endsAt: row.ends_at ? toIso(row.ends_at) : null,
    recordVersion: toVersion(row.record_version),
  });
}

function toGuardianHint(row: GuardianHintRow): GuardianContactHint {
  return Object.freeze({
    id: row.id,
    displayName: row.display_name,
    emailHint: row.email_hint,
    phoneHint: row.phone_hint,
  });
}

function toIso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw error("GUARDIAN_RELATIONSHIP_UNAVAILABLE");
  return date.toISOString();
}

function toVersion(value: number | string): number {
  const result = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(result) || result < 1) {
    throw error("GUARDIAN_RELATIONSHIP_UNAVAILABLE");
  }
  return result;
}

function mapPostgresError(cause: unknown): GuardianRelationshipError {
  if (isPostgresError(cause, "23505", "crm_relationships_one_current_pair_idx")) {
    return error("GUARDIAN_RELATIONSHIP_CURRENT_PAIR_EXISTS");
  }
  if (isPostgresError(cause, "23505", "crm_relationships_one_current_primary_idx")) {
    return error("GUARDIAN_RELATIONSHIP_PRIMARY_CONFLICT");
  }
  return error("GUARDIAN_RELATIONSHIP_UNAVAILABLE");
}

function isPostgresError(cause: unknown, code: string, constraint: string): boolean {
  return cause instanceof Error &&
    (cause as Error & { readonly code?: unknown }).code === code &&
    (cause as Error & { readonly constraint?: unknown }).constraint === constraint;
}

function readConcurrencyPostgresCode(cause: unknown): ConcurrencyPostgresCode | null {
  if (!(cause instanceof Error)) return null;
  const candidate = cause as Error & { readonly code?: unknown; readonly severity?: unknown };
  if (typeof candidate.code !== "string" || !CONCURRENCY_POSTGRES_CODES.has(candidate.code) ||
      typeof candidate.severity !== "string" || !POSTGRES_SEVERITIES.has(candidate.severity)) {
    return null;
  }
  return candidate.code as ConcurrencyPostgresCode;
}

function writeSafePostgresFailure(evidence: Readonly<{ postgresCode: ConcurrencyPostgresCode }>): void {
  process.stderr.write(
    `event=guardian_relationship_postgres_failure postgres_code=${evidence.postgresCode}\n`,
  );
}

function error(code: ConstructorParameters<typeof GuardianRelationshipError>[0]) {
  return new GuardianRelationshipError(code);
}

interface CrmTransaction {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: readonly Row[]; readonly rowCount: number }>;
}

function adaptTransaction(transaction: TenantTransaction): CrmTransaction {
  return Object.freeze({
    async query<Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) {
      const result = await transaction.query<Row>({ text, values });
      return Object.freeze({ rows: result.rows, rowCount: result.rowCount ?? result.rows.length });
    },
  });
}
