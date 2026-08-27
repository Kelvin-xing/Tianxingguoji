import "server-only";

import { appendAtomicMutationEffects } from "../../audit/server.ts";
import { hashRequestPayload } from "../../shared/public.ts";
import type { TenantTransaction, TenantTransactionRunner } from "../../shared/server.ts";
import {
  ProfileMaintenanceError,
  isProfileMaintenanceError,
  type ProfileMaintenanceRepository,
  type ProfileUpdateAcknowledgement,
} from "../application/profile-maintenance-service.ts";

const STUDENT_OPERATION = "crm.update_student_profile";
const GUARDIAN_OPERATION = "crm.update_guardian_profile";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RECEIPT_REFERENCE = /^([0-9a-f-]{36}):(\d{1,16}):(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)$/i;

interface ReceiptRow extends Record<string, unknown> {
  request_hash: string;
  state: string;
  result_reference: string | null;
  response_hash: string | null;
}

interface TargetStateRow extends Record<string, unknown> {
  status: string;
}

interface UpdatedRow extends Record<string, unknown> {
  id: string;
  record_version: number | string;
  updated_at: Date | string;
}

export class PostgresqlProfileMaintenanceRepository implements ProfileMaintenanceRepository {
  private readonly runner: TenantTransactionRunner;

  constructor(runner: TenantTransactionRunner) {
    this.runner = runner;
  }

  updateStudent(input: Parameters<ProfileMaintenanceRepository["updateStudent"]>[0]) {
    return this.run(input, async (transaction) => {
      const receipt = await claimReceipt(transaction, input, STUDENT_OPERATION, input.studentId);
      const state = await readTargetState(transaction, "crm_students", input.studentId);
      if (state === null || state === "purged") throw notFound();
      await assertStudentAccess(transaction, input);
      if (receipt !== null) return receipt;
      if (state !== "active") throw inactive();
      const locked = await lockTarget(transaction, "crm_students", input.studentId);
      if (locked === null || locked.status !== "active") {
        if (locked === null || locked.status === "purged") throw notFound();
        throw inactive();
      }
      if (locked.recordVersion !== input.expectedRecordVersion) throw stale();
      const result = await transaction.query<UpdatedRow>(
        `UPDATE crm_students
            SET display_name = $2, date_of_birth = $3, gender = $4, contact_email = $5,
                contact_phone = $6, record_version = record_version + 1,
                updated_at = clock_timestamp()
          WHERE id = $1 AND status = 'active' AND record_version = $7
        RETURNING id, record_version, updated_at`,
        [input.studentId, input.displayName, input.dateOfBirth, input.gender, input.contactEmail,
          input.contactPhone, input.expectedRecordVersion],
      );
      const acknowledgement = toAcknowledgement(result.rows[0]);
      if (!acknowledgement) throw stale();
      await appendAtomicMutationEffects(transaction, input.effects);
      await completeReceipt(transaction, input, STUDENT_OPERATION, acknowledgement);
      return acknowledgement;
    });
  }

  updateGuardian(input: Parameters<ProfileMaintenanceRepository["updateGuardian"]>[0]) {
    return this.run(input, async (transaction) => {
      const receipt = await claimReceipt(transaction, input, GUARDIAN_OPERATION, input.guardianId);
      const state = await readTargetState(transaction, "crm_guardians", input.guardianId);
      if (state === null || state === "purged") throw notFound();
      await assertGuardianAccess(transaction, input, state);
      if (receipt !== null) return receipt;
      if (state !== "active") throw inactive();
      const locked = await lockTarget(transaction, "crm_guardians", input.guardianId);
      if (locked === null || locked.status !== "active") {
        if (locked === null || locked.status === "purged") throw notFound();
        throw inactive();
      }
      if (locked.recordVersion !== input.expectedRecordVersion) throw stale();
      const result = await transaction.query<UpdatedRow>(
        `UPDATE crm_guardians
            SET display_name = $2, date_of_birth = $3, gender = $4, email = $5, phone = $6,
                record_version = record_version + 1, updated_at = clock_timestamp()
          WHERE id = $1 AND status = 'active' AND record_version = $7
        RETURNING id, record_version, updated_at`,
        [input.guardianId, input.displayName, input.dateOfBirth, input.gender, input.email, input.phone,
          input.expectedRecordVersion],
      );
      const acknowledgement = toAcknowledgement(result.rows[0]);
      if (!acknowledgement) throw stale();
      await appendAtomicMutationEffects(transaction, input.effects);
      await completeReceipt(transaction, input, GUARDIAN_OPERATION, acknowledgement);
      return acknowledgement;
    });
  }

  private run<Result>(
    input: { readonly organizationId: string; readonly actorUserId: string },
    operation: (transaction: CrmTransaction) => Promise<Result>,
  ): Promise<Result> {
    return this.runner.run({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
    }, async (tenantTransaction) => {
      try {
        return await operation(adaptTransaction(tenantTransaction));
      } catch (error) {
        if (isProfileMaintenanceError(error)) throw error;
        throw unavailable();
      }
    });
  }
}

async function claimReceipt(
  transaction: CrmTransaction,
  input: ReceiptInput,
  operation: string,
  expectedTargetId: string,
): Promise<ProfileUpdateAcknowledgement | null> {
  const claim = await transaction.query(
    `INSERT INTO shared_idempotency_records
      (id, organization_id, actor_user_id, operation, idempotency_key, request_hash, state)
     VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,'in_progress')
     ON CONFLICT (organization_id, actor_user_id, operation, idempotency_key) DO NOTHING
     RETURNING id`,
    [input.organizationId, input.actorUserId, operation, input.idempotencyKey, input.requestHash],
  );
  const selected = await transaction.query<ReceiptRow>(
    `SELECT request_hash, state, result_reference, response_hash
       FROM shared_idempotency_records
      WHERE organization_id = $1 AND actor_user_id = $2
        AND operation = $3 AND idempotency_key = $4
      FOR UPDATE`,
    [input.organizationId, input.actorUserId, operation, input.idempotencyKey],
  );
  if (claim.rowCount === 1) return null;
  const receipt = selected.rows[0];
  if (!receipt || receipt.request_hash !== input.requestHash) {
    throw new ProfileMaintenanceError("PROFILE_MAINTENANCE_IDEMPOTENCY_CONFLICT");
  }
  if (receipt.state !== "completed" || !receipt.result_reference || !receipt.response_hash) {
    throw new ProfileMaintenanceError("PROFILE_MAINTENANCE_IDEMPOTENCY_IN_PROGRESS");
  }
  const acknowledgement = parseReference(receipt.result_reference, expectedTargetId);
  if (receipt.response_hash !== hashAcknowledgement(acknowledgement)) throw unavailable();
  return acknowledgement;
}

async function completeReceipt(
  transaction: CrmTransaction,
  input: ReceiptInput,
  operation: string,
  acknowledgement: ProfileUpdateAcknowledgement,
): Promise<void> {
  const reference = `${acknowledgement.id}:${acknowledgement.recordVersion}:${acknowledgement.updatedAt}`;
  if (reference.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(reference)) {
    throw unavailable();
  }
  const responseHash = hashAcknowledgement(acknowledgement);
  const result = await transaction.query(
    `UPDATE shared_idempotency_records
        SET state = 'completed', result_reference = $5, response_hash = $6,
            record_version = record_version + 1, updated_at = transaction_timestamp()
      WHERE organization_id = $1 AND actor_user_id = $2
        AND operation = $3 AND idempotency_key = $4
        AND request_hash = $7 AND state = 'in_progress'`,
    [input.organizationId, input.actorUserId, operation, input.idempotencyKey,
      reference, responseHash, input.requestHash],
  );
  if (result.rowCount !== 1) throw unavailable();
}

function hashAcknowledgement(acknowledgement: ProfileUpdateAcknowledgement): string {
  return hashRequestPayload({
    id: acknowledgement.id,
    record_version: acknowledgement.recordVersion,
    updated_at: acknowledgement.updatedAt,
  });
}

async function readTargetState(
  transaction: CrmTransaction,
  table: "crm_students" | "crm_guardians",
  id: string,
): Promise<string | null> {
  const result = await transaction.query<TargetStateRow>(`SELECT status FROM ${table} WHERE id = $1`, [id]);
  return result.rows[0]?.status ?? null;
}

async function lockTarget(
  transaction: CrmTransaction,
  table: "crm_students" | "crm_guardians",
  id: string,
): Promise<{ readonly status: string; readonly recordVersion: number } | null> {
  const result = await transaction.query<TargetStateRow & { record_version: number | string }>(
    `SELECT status, record_version FROM ${table} WHERE id = $1 FOR UPDATE`, [id],
  );
  const row = result.rows[0];
  return row ? Object.freeze({ status: row.status, recordVersion: version(row.record_version) }) : null;
}

async function assertStudentAccess(
  transaction: CrmTransaction,
  input: { readonly actorRole: string; readonly actorUserId: string; readonly studentId: string },
): Promise<void> {
  if (input.actorRole === "founder") return;
  if (input.actorRole !== "advisor") throw forbidden();
  const result = await transaction.query<{ id: string }>(
    `SELECT service_case.id
       FROM cases_service_cases AS service_case
      WHERE service_case.student_id = $1
        AND service_case.primary_user_id = $2
        AND service_case.primary_role = 'advisor'
        AND service_case.stage <> 'closed'
      ORDER BY service_case.id
      LIMIT 1
      FOR SHARE OF service_case`,
    [input.studentId, input.actorUserId],
  );
  if (!result.rows[0]) throw forbidden();
}

async function assertGuardianAccess(
  transaction: CrmTransaction,
  input: { readonly actorRole: string; readonly actorUserId: string; readonly guardianId: string },
  guardianStatus: string,
): Promise<void> {
  if (input.actorRole === "founder") return;
  if (input.actorRole !== "advisor") throw forbidden();
  const result = await transaction.query<{ id: string }>(
    `SELECT relationship.id
       FROM crm_student_guardian_relationships AS relationship
       JOIN crm_students AS student ON student.id = relationship.student_id
       JOIN cases_service_cases AS service_case ON service_case.student_id = student.id
      WHERE relationship.guardian_id = $1 AND relationship.ends_at IS NULL
        AND (student.status = 'active'
          OR ($3 = 'pending_delete' AND student.status = 'pending_delete'))
        AND service_case.primary_user_id = $2
        AND service_case.primary_role = 'advisor'
        AND service_case.stage <> 'closed'
      ORDER BY relationship.id, service_case.id
      LIMIT 1
      FOR SHARE OF relationship, student, service_case`,
    [input.guardianId, input.actorUserId, guardianStatus],
  );
  if (!result.rows[0]) throw forbidden();
}

function toAcknowledgement(row: UpdatedRow | undefined): ProfileUpdateAcknowledgement | null {
  if (!row || !UUID.test(row.id)) return null;
  const updatedAt = new Date(row.updated_at).toISOString();
  if (updatedAt === "Invalid Date") throw unavailable();
  return Object.freeze({ id: row.id, recordVersion: version(row.record_version), updatedAt });
}

function parseReference(reference: string, expectedId: string): ProfileUpdateAcknowledgement {
  const match = RECEIPT_REFERENCE.exec(reference);
  if (!match || match[1] !== expectedId || !UUID.test(match[1])) throw unavailable();
  const updatedAt = new Date(match[3]!).toISOString();
  return Object.freeze({ id: match[1], recordVersion: version(match[2]!), updatedAt });
}

function version(value: number | string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw unavailable();
  return parsed;
}

interface ReceiptInput {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
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

function forbidden() { return new ProfileMaintenanceError("PROFILE_MAINTENANCE_FORBIDDEN"); }
function notFound() { return new ProfileMaintenanceError("PROFILE_MAINTENANCE_NOT_FOUND"); }
function inactive() { return new ProfileMaintenanceError("PROFILE_MAINTENANCE_INACTIVE"); }
function stale() { return new ProfileMaintenanceError("PROFILE_MAINTENANCE_STALE_VERSION"); }
function unavailable() { return new ProfileMaintenanceError("PROFILE_MAINTENANCE_UNAVAILABLE"); }
