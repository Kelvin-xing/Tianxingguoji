import "server-only";

import { appendAtomicMutationEffects } from "../../audit/server.ts";
import {
  StudentCreateRepositoryError,
  type CreatedStudentAggregate,
  type StudentCreateRepository,
} from "../application/student-create-service.ts";
import type { TenantTransaction, TenantTransactionRunner } from "../../shared/server.ts";
import { runIdempotentTransaction, IdempotencyExecutionError } from "../../shared/server.ts";
import { hashRequestPayload } from "../../shared/public.ts";
import { findPotentialDuplicateCandidatesInTransaction } from "./postgresql-potential-duplicate-repository.ts";
import { canonicalPotentialDuplicateFieldsHash, verifyPotentialDuplicateWarningToken } from "./potential-duplicate-token-codec.ts";
import { normalizeDisplayName, normalizeEmail, normalizePhone } from "../domain/approved-p2-contract.ts";

const OPERATION = "crm.create_student_primary_guardian";

interface CreatedRow extends Record<string, unknown> {
  student_id: string;
  student_record_version: string|number;
  guardian_id: string;
  guardian_record_version: string|number;
  relationship_id: string;
  relationship_record_version: string|number;
}

export class PostgresqlStudentCreateRepository implements StudentCreateRepository {
  private readonly runner: TenantTransactionRunner;

  constructor(runner: TenantTransactionRunner) {
    this.runner = runner;
  }

  createStudent(input: Parameters<StudentCreateRepository["createStudent"]>[0]) {
    const context = {
      organizationId: input.organizationId,
      actorKind: "user" as const, actorOpaqueId: input.actorUserId,
      actorUserId: input.actorUserId, requestId: input.effects.audit.requestId,
    };
    return runIdempotentTransaction({ runner: this.runner, context, claim: {
      id: input.studentId, organizationId: input.organizationId, actorKind: "user", actorOpaqueId: input.actorUserId,
      operation: OPERATION, key: input.idempotencyKey, requestHash: input.requestHash, createdAt: new Date(input.createdAtMs).toISOString(),
    }, revalidate: async (tx) => { await assertCurrentStudentCreator(tx, input); }, execute: async (tx) => {
      await assertDuplicateAcknowledged(tx,{organizationId:input.organizationId,actorUserId:input.actorUserId,kind:"student",name:input.student.displayName,email:input.student.contactEmail,phone:input.student.contactPhone,warningToken:input.student.warningToken??null,nowMs:input.createdAtMs});
      if (input.primaryGuardian.kind === "new") await assertDuplicateAcknowledged(tx,{organizationId:input.organizationId,actorUserId:input.actorUserId,kind:"guardian",name:input.primaryGuardian.displayName,email:input.primaryGuardian.email,phone:input.primaryGuardian.phone,warningToken:input.primaryGuardian.warningToken??null,nowMs:input.createdAtMs});
      const value = await createStudentInTransaction(adaptTransaction(tx), input);
      const responseHash = hashRequestPayload(receiptJson(value));
      return { state: "completed" as const, resultReference: value.student.id, responseHash, updatedAt: new Date(input.createdAtMs).toISOString(), value };
    }}).then(async (result) => {
      if (result.status === "executed") return result.value;
      return this.runner.run(context, async (tx) => {
        const value = await selectCreatedAggregate(adaptTransaction(tx), result.resultReference);
        if (!value || hashRequestPayload(receiptJson(value)) !== result.responseHash) throw new StudentCreateRepositoryError("STUDENT_CREATE_UNAVAILABLE");
        return value;
      });
    }).catch((error) => {
      if (error instanceof IdempotencyExecutionError) throw new StudentCreateRepositoryError(error.code === "IDEMPOTENCY_IN_PROGRESS" ? "STUDENT_CREATE_IDEMPOTENCY_IN_PROGRESS" : error.code === "IDEMPOTENCY_KEY_REUSED" ? "STUDENT_CREATE_IDEMPOTENCY_CONFLICT" : "STUDENT_CREATE_UNAVAILABLE");
      if (error instanceof StudentCreateRepositoryError) throw error;
      throw new StudentCreateRepositoryError("STUDENT_CREATE_UNAVAILABLE");
    });
  }
}

function receiptJson(value: CreatedStudentAggregate) { return { student: { id: value.student.id, record_version: value.student.recordVersion }, primary_guardian: { id: value.primaryGuardian.id, record_version: value.primaryGuardian.recordVersion }, relationship: { id: value.relationship.id, record_version: value.relationship.recordVersion } }; }

async function assertDuplicateAcknowledged(tx: TenantTransaction, input: {organizationId:string;actorUserId:string;kind:"student"|"guardian";name:string|null;email:string|null;phone:string|null;warningToken:string|null;nowMs:number}): Promise<void> {
  const name=normalizeDisplayName(input.name); const email=normalizeEmail(input.email); const phone=normalizePhone(input.phone);
  const fields: Array<[string,string]> = []; if (name) fields.push(["name",name]); if (email) fields.push(["email",email]); if (phone) fields.push(["phone",phone]);
  for (const [field,value] of fields.sort(([a],[b])=>a.localeCompare(b))) { const single = field === "name" ? {name:value,email:null,phone:null} : field === "email" ? {name:null,email:value,phone:null} : {name:null,email:null,phone:value}; await tx.query({text:"SELECT pg_advisory_xact_lock(hashtextextended($1,0))",values:[`${input.organizationId}:${input.kind}:${field}:${canonicalPotentialDuplicateFieldsHash(single)}`]}); }
  const found=await findPotentialDuplicateCandidatesInTransaction(tx,{...input,name,email,phone},true);
  if (found.candidates.length===0) return;
  if (!input.warningToken || !verifyPotentialDuplicateWarningToken(input.warningToken,{org:input.organizationId,actor:input.actorUserId,kind:input.kind,fieldsHash:canonicalPotentialDuplicateFieldsHash({name,email,phone}),candidateVersion:found.candidateVersion},input.nowMs)) throw new StudentCreateRepositoryError("STUDENT_CREATE_DUPLICATE_WARNING_REQUIRED");
}

async function assertCurrentStudentCreator(transaction: TenantTransaction, input: Parameters<StudentCreateRepository["createStudent"]>[0]): Promise<void> {
  const result = await transaction.query<{ ok: boolean }>({
    text: `SELECT true AS ok
      FROM identity_users u
      JOIN identity_memberships m ON m.user_id=u.id AND m.organization_id=$1 AND m.status='active'
      JOIN access_role_bindings rb ON rb.membership_id=m.id AND rb.status='active'
      WHERE u.id=$2 AND u.status='active' AND rb.role IN ('founder','advisor')
      FOR SHARE`, values: [input.organizationId, input.actorUserId],
  });
  if (result.rows.length === 0) throw new StudentCreateRepositoryError("STUDENT_CREATE_FORBIDDEN");
}

async function createStudentInTransaction(
  transaction: StudentCreateTransaction,
  input: Parameters<StudentCreateRepository["createStudent"]>[0],
): Promise<CreatedStudentAggregate> {
  await transaction.query(
    `INSERT INTO crm_students
      (id, organization_id, display_name, date_of_birth, gender, contact_email, contact_phone, status)
     VALUES ($1,$2,$3,$4::date,$5,$6,$7,'active')`,
    [input.studentId, input.organizationId, input.student.displayName,
      input.student.dateOfBirth, input.student.gender, input.student.contactEmail, input.student.contactPhone],
  );
  if (input.primaryGuardian.kind === "existing") {
    const guardian = await transaction.query<{ id:string; record_version:number|string }>(`SELECT id,record_version FROM crm_guardians WHERE id=$1 AND organization_id=$2 AND status='active' FOR SHARE`, [input.primaryGuardian.guardianId, input.organizationId]);
    if (guardian.rows.length !== 1) throw new StudentCreateRepositoryError("STUDENT_CREATE_INVALID");
  } else await transaction.query(
    `INSERT INTO crm_guardians
      (id, organization_id, display_name, date_of_birth, gender, email, phone, status)
     VALUES ($1,$2,$3,$4::date,$5,$6,$7,'active')`,
    [input.guardianId, input.organizationId, input.primaryGuardian.displayName,
      input.primaryGuardian.dateOfBirth, input.primaryGuardian.gender,
      input.primaryGuardian.email, input.primaryGuardian.phone],
  );
  await transaction.query(
    `INSERT INTO crm_student_guardian_relationships
      (id, organization_id, student_id, guardian_id, relationship_type, relationship_description, is_legal_guardian,
       is_primary_contact, is_emergency_contact, is_billing_contact, notification_consent,
       starts_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,true,$8,$9,$10,transaction_timestamp())`,
    [input.relationshipId, input.organizationId, input.studentId, input.guardianId,
      input.primaryGuardian.relationshipType, input.primaryGuardian.relationshipDescription,
      input.primaryGuardian.isLegalGuardian, input.primaryGuardian.isEmergencyContact,
      input.primaryGuardian.isBillingContact, input.primaryGuardian.notificationConsent],
  );
  await appendAtomicMutationEffects(transaction, input.effects);
  const created = await selectCreatedAggregate(transaction, input.studentId);
  if (!created) throw new StudentCreateRepositoryError("STUDENT_CREATE_UNAVAILABLE");
  return created;
}

async function selectCreatedAggregate(
  transaction: StudentCreateTransaction,
  studentId: string,
): Promise<CreatedStudentAggregate | null> {
  const result = await transaction.query<CreatedRow>(
    `SELECT student.id AS student_id, student.record_version AS student_record_version,
            guardian.id AS guardian_id, guardian.record_version AS guardian_record_version,
            relationship.id AS relationship_id, relationship.record_version AS relationship_record_version
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
    student: Object.freeze({ id: row.student_id, recordVersion: Number(row.student_record_version) }),
    primaryGuardian: Object.freeze({ id: row.guardian_id, recordVersion: Number(row.guardian_record_version) }),
    relationship: Object.freeze({ id: row.relationship_id, recordVersion: Number(row.relationship_record_version) }),
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
