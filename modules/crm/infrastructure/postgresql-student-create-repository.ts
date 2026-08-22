import "server-only";

import { appendAtomicMutationEffects } from "../../audit/server.ts";
import {
  StudentCreateRepositoryError,
  type CreatedStudentAggregate,
  type StudentCreateRepository,
} from "../application/student-create-service.ts";
import type { TenantTransaction, TenantTransactionRunner } from "../../shared/server.ts";

const OPERATION = "crm.create_student_primary_guardian";

interface CreatedRow extends Record<string, unknown> {
  student_id: string;
  student_display_name: string;
  guardian_id: string;
  guardian_display_name: string;
  relationship_id: string;
  relationship_type: CreatedStudentAggregate["relationship"]["relationshipType"];
}

export class PostgresqlStudentCreateRepository implements StudentCreateRepository {
  private readonly runner: TenantTransactionRunner;

  constructor(runner: TenantTransactionRunner) {
    this.runner = runner;
  }

  createStudent(input: Parameters<StudentCreateRepository["createStudent"]>[0]) {
    return this.runner.run({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
    }, async (tenantTransaction) => {
      const transaction = adaptTransaction(tenantTransaction);
      try {
        return await createStudentInTransaction(transaction, input);
      } catch (error) {
        if (error instanceof StudentCreateRepositoryError) throw error;
        throw new StudentCreateRepositoryError("STUDENT_CREATE_UNAVAILABLE");
      }
    });
  }
}

async function createStudentInTransaction(
  transaction: StudentCreateTransaction,
  input: Parameters<StudentCreateRepository["createStudent"]>[0],
): Promise<CreatedStudentAggregate> {
  const claim = await transaction.query(
    `INSERT INTO shared_idempotency_records
      (id, organization_id, actor_user_id, operation, idempotency_key, request_hash, state)
     VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,'in_progress')
     ON CONFLICT (organization_id, actor_user_id, operation, idempotency_key) DO NOTHING
     RETURNING id`,
    [input.organizationId, input.actorUserId, OPERATION, input.idempotencyKey, input.requestHash],
  );
  const receipt = await transaction.query<{
    request_hash: string;
    state: string;
    result_reference: string | null;
  }>(
    `SELECT request_hash, state, result_reference
       FROM shared_idempotency_records
      WHERE organization_id = $1 AND actor_user_id = $2
        AND operation = $3 AND idempotency_key = $4
      FOR UPDATE`,
    [input.organizationId, input.actorUserId, OPERATION, input.idempotencyKey],
  );

  if (claim.rowCount === 0) {
    const stored = receipt.rows[0];
    if (stored && stored.request_hash !== input.requestHash) {
      throw new StudentCreateRepositoryError("STUDENT_CREATE_IDEMPOTENCY_CONFLICT");
    }
    if (!stored || stored.state !== "completed" || !stored.result_reference) {
      throw new StudentCreateRepositoryError("STUDENT_CREATE_IDEMPOTENCY_IN_PROGRESS");
    }
    const replay = await selectCreatedAggregate(transaction, stored.result_reference);
    if (!replay) {
      throw new StudentCreateRepositoryError("STUDENT_CREATE_IDEMPOTENCY_IN_PROGRESS");
    }
    return replay;
  }

  await transaction.query(
    `INSERT INTO crm_students
      (id, organization_id, display_name, date_of_birth, contact_email, contact_phone, status)
     VALUES ($1,$2,$3,$4::date,$5,$6,'active')`,
    [input.studentId, input.organizationId, input.student.displayName,
      input.student.dateOfBirth, input.student.contactEmail, input.student.contactPhone],
  );
  await transaction.query(
    `INSERT INTO crm_guardians
      (id, organization_id, display_name, email, phone, status)
     VALUES ($1,$2,$3,$4,$5,'active')`,
    [input.guardianId, input.organizationId, input.primaryGuardian.displayName,
      input.primaryGuardian.email, input.primaryGuardian.phone],
  );
  await transaction.query(
    `INSERT INTO crm_student_guardian_relationships
      (id, organization_id, student_id, guardian_id, relationship_type, is_legal_guardian,
       is_primary_contact, is_emergency_contact, is_billing_contact, notification_consent,
       starts_at)
     VALUES ($1,$2,$3,$4,$5,$6,true,false,false,false,transaction_timestamp())`,
    [input.relationshipId, input.organizationId, input.studentId, input.guardianId,
      input.primaryGuardian.relationshipType, input.primaryGuardian.isLegalGuardian],
  );
  await appendAtomicMutationEffects(transaction, input.effects);
  const completion = await transaction.query(
    `UPDATE shared_idempotency_records
        SET state = 'completed', result_reference = $5, response_hash = $6,
            record_version = record_version + 1, updated_at = transaction_timestamp()
      WHERE organization_id = $1 AND actor_user_id = $2
        AND operation = $3 AND idempotency_key = $4
        AND request_hash = $6 AND state = 'in_progress'`,
    [input.organizationId, input.actorUserId, OPERATION, input.idempotencyKey,
      input.studentId, input.requestHash],
  );
  if (completion.rowCount !== 1) {
    throw new StudentCreateRepositoryError("STUDENT_CREATE_UNAVAILABLE");
  }
  return createdAggregate(input);
}

async function selectCreatedAggregate(
  transaction: StudentCreateTransaction,
  studentId: string,
): Promise<CreatedStudentAggregate | null> {
  const result = await transaction.query<CreatedRow>(
    `SELECT student.id AS student_id, student.display_name AS student_display_name,
            guardian.id AS guardian_id, guardian.display_name AS guardian_display_name,
            relationship.id AS relationship_id, relationship.relationship_type
       FROM crm_students AS student
       JOIN crm_student_guardian_relationships AS relationship
         ON relationship.student_id = student.id
        AND relationship.organization_id = student.organization_id
        AND relationship.is_primary_contact
        AND relationship.ends_at IS NULL
       JOIN crm_guardians AS guardian
         ON guardian.id = relationship.guardian_id
        AND guardian.organization_id = relationship.organization_id
      WHERE student.id = $1 AND student.status = 'active' AND guardian.status = 'active'`,
    [studentId],
  );
  const row = result.rows[0];
  return row ? Object.freeze({
    student: Object.freeze({ id: row.student_id, displayName: row.student_display_name }),
    primaryGuardian: Object.freeze({ id: row.guardian_id, displayName: row.guardian_display_name }),
    relationship: Object.freeze({
      id: row.relationship_id,
      relationshipType: row.relationship_type,
    }),
  }) : null;
}

interface StudentCreateTransaction {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: readonly Row[]; readonly rowCount: number }>;
}

function adaptTransaction(transaction: TenantTransaction): StudentCreateTransaction {
  return Object.freeze({
    async query<Row extends Record<string, unknown>>(
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

function createdAggregate(
  input: Parameters<StudentCreateRepository["createStudent"]>[0],
): CreatedStudentAggregate {
  return Object.freeze({
    student: Object.freeze({ id: input.studentId, displayName: input.student.displayName }),
    primaryGuardian: Object.freeze({
      id: input.guardianId,
      displayName: input.primaryGuardian.displayName,
    }),
    relationship: Object.freeze({
      id: input.relationshipId,
      relationshipType: input.primaryGuardian.relationshipType,
    }),
  });
}
