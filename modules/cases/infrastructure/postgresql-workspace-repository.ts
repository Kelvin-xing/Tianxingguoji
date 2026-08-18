import "server-only";

import { appendAtomicMutationEffects } from "../../audit/server.ts";
import type {
  CaseWorkspaceDetail,
  CaseWorkspaceListItem,
  CaseWorkspaceOptions,
  CaseWorkspaceRepository,
  CreatedExistingStudentCase,
} from "../application/workspace-service.ts";
import { CaseWorkspaceRepositoryError } from "../application/workspace-service.ts";
import type { PostgreSqlAdapter, PostgreSqlTransaction } from "./postgresql.ts";

interface CaseRow extends Record<string, unknown> {
  id: string;
  case_number: string;
  student_id: string;
  student_name: string;
  intake_year: number;
  admission_type: string;
  stage: CaseWorkspaceListItem["stage"];
  updated_at: Date | string;
  primary_role: "founder" | "advisor";
  assessment_id?: string;
  assessment_status?: CaseWorkspaceDetail["assessmentStatus"];
  manifest_id?: string;
  primary_role_binding_id?: string;
  record_version?: number | string;
}

export class PostgresqlCaseWorkspaceRepository implements CaseWorkspaceRepository {
  private readonly database: PostgreSqlAdapter;

  constructor(database: PostgreSqlAdapter) {
    this.database = database;
  }

  listCases(input: Parameters<CaseWorkspaceRepository["listCases"]>[0]) {
    return this.database.transaction(input, async (transaction) => {
      const result = await transaction.query<CaseRow>(
        caseSelect(input.actorRole === "advisor" ? "service_case.primary_user_id = $1" : "true") +
          " ORDER BY service_case.updated_at DESC, service_case.id",
        input.actorRole === "advisor" ? [input.actorUserId] : [],
      );
      return Object.freeze(result.rows.map(toListItem));
    });
  }

  findCase(input: Parameters<CaseWorkspaceRepository["findCase"]>[0]) {
    return this.database.transaction(input, async (transaction) => {
      const values = input.actorRole === "advisor"
        ? [input.caseId, input.actorUserId]
        : [input.caseId];
      const actorFilter = input.actorRole === "advisor"
        ? "service_case.id = $1 AND service_case.primary_user_id = $2"
        : "service_case.id = $1";
      const result = await transaction.query<CaseRow>(
        `SELECT service_case.id, service_case.case_number, service_case.student_id,
                student.display_name AS student_name, service_case.intake_year,
                service_case.admission_type, service_case.stage, service_case.updated_at,
                service_case.primary_role, service_case.primary_role_binding_id,
                service_case.record_version, assessment.id AS assessment_id,
                assessment.status AS assessment_status, assessment.manifest_id
           FROM cases_service_cases AS service_case
           JOIN crm_students AS student
             ON student.id = service_case.student_id
            AND student.organization_id = service_case.organization_id
           JOIN cases_assessments AS assessment
             ON assessment.service_case_id = service_case.id
            AND assessment.organization_id = service_case.organization_id
          WHERE ${actorFilter}`,
        values,
      );
      const row = result.rows[0];
      if (!row || !row.assessment_id || !row.assessment_status || !row.manifest_id ||
          !row.primary_role_binding_id || row.record_version === undefined) return null;
      return Object.freeze({
        ...toListItem(row),
        assessmentId: row.assessment_id,
        assessmentStatus: row.assessment_status,
        manifestId: row.manifest_id,
        primaryBindingLabel: `${row.primary_role === "advisor" ? "Advisor" : "Founder"} · ${row.primary_role_binding_id.slice(-8)}`,
        recordVersion: Number(row.record_version),
      }) satisfies CaseWorkspaceDetail;
    });
  }

  listOptions(input: Parameters<CaseWorkspaceRepository["listOptions"]>[0]) {
    return this.database.transaction(input, async (transaction) => {
      const students = await transaction.query<{ id: string; display_name: string }>(
          `SELECT id, display_name FROM crm_students
            WHERE status = 'active' ORDER BY display_name, id`,
        );
      const bindings = await transaction.query<{
        id: string;
        role: "founder" | "advisor";
        user_id: string;
      }>(
          `SELECT role_binding.id, role_binding.role, role_binding.user_id
             FROM access_role_bindings AS role_binding
             JOIN access_organization_memberships AS membership
               ON membership.id = role_binding.membership_id
              AND membership.organization_id = role_binding.organization_id
            WHERE role_binding.role IN ('founder', 'advisor')
              AND role_binding.status = 'active'
              AND membership.status = 'active'
              AND identity_user_is_active(role_binding.user_id)
              AND access_organization_is_active(role_binding.organization_id)
              AND ($1::boolean = false OR role_binding.user_id = $2)
            ORDER BY role_binding.role, role_binding.id`,
          [input.actorRole === "advisor", input.actorUserId],
        );
      const manifests = await transaction.query<{ id: string; composition_version: string }>(
          "SELECT id, composition_version FROM cases_list_approved_manifests()",
        );
      return Object.freeze({
        students: Object.freeze(students.rows.map((row) => Object.freeze({
          id: row.id,
          displayName: row.display_name,
        }))),
        primaryBindings: Object.freeze(bindings.rows.map((row) => Object.freeze({
          id: row.id,
          role: row.role,
          label: `${row.user_id === input.actorUserId ? "我的 " : ""}${row.role === "advisor" ? "Advisor" : "Founder"} · ${row.id.slice(-8)}`,
        }))),
        manifests: Object.freeze(manifests.rows.map((row) => Object.freeze({
          id: row.id,
          compositionVersion: row.composition_version,
          label: `K12 · ${row.composition_version}`,
        }))),
      }) satisfies CaseWorkspaceOptions;
    });
  }

  createCase(input: Parameters<CaseWorkspaceRepository["createCase"]>[0]) {
    return this.database.transaction(input, async (transaction) => {
      try {
        return await createCaseInTransaction(transaction, input);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new CaseWorkspaceRepositoryError("CASE_WORKSPACE_DUPLICATE");
        }
        throw error;
      }
    });
  }
}

async function createCaseInTransaction(
  transaction: PostgreSqlTransaction,
  input: Parameters<CaseWorkspaceRepository["createCase"]>[0],
): Promise<CreatedExistingStudentCase> {
  const claim = await transaction.query(
    `INSERT INTO shared_idempotency_records
      (id, organization_id, actor_user_id, operation, idempotency_key, request_hash,
       state, created_at, updated_at)
     VALUES (gen_random_uuid(),$1,$2,'cases.create_existing_student',$3,$4,'in_progress',
       to_timestamp($5 / 1000.0),to_timestamp($5 / 1000.0))
     ON CONFLICT (organization_id, actor_user_id, operation, idempotency_key) DO NOTHING
     RETURNING id`,
    [input.organizationId, input.actorUserId, input.idempotencyKey, input.requestHash,
      input.createdAtMs],
  );
  const receipt = await transaction.query<{
    request_hash: string;
    state: string;
    result_reference: string | null;
  }>(
    `SELECT request_hash, state, result_reference FROM shared_idempotency_records
      WHERE organization_id = $1 AND actor_user_id = $2
        AND operation = 'cases.create_existing_student' AND idempotency_key = $3
      FOR UPDATE`,
    [input.organizationId, input.actorUserId, input.idempotencyKey],
  );
  if (claim.rowCount === 0) {
    const storedReceipt = receipt.rows[0];
    if (storedReceipt && storedReceipt.request_hash !== input.requestHash) {
      throw new CaseWorkspaceRepositoryError("CASE_WORKSPACE_IDEMPOTENCY_CONFLICT");
    }
    if (!storedReceipt || storedReceipt.state !== "completed" || !storedReceipt.result_reference) {
      throw new CaseWorkspaceRepositoryError("CASE_WORKSPACE_IDEMPOTENCY_IN_PROGRESS");
    }
    const replay = await transaction.query<CaseRow>(
      `SELECT service_case.id, service_case.case_number, service_case.student_id,
              service_case.intake_year, service_case.admission_type, service_case.stage,
              assessment.id AS assessment_id, assessment.manifest_id,
              service_case.record_version
         FROM cases_service_cases AS service_case
         JOIN cases_assessments AS assessment
           ON assessment.service_case_id = service_case.id
          AND assessment.organization_id = service_case.organization_id
        WHERE service_case.id = $1`,
      [storedReceipt.result_reference],
    );
    const row = replay.rows[0];
    if (!row || !row.assessment_id || !row.manifest_id) {
      throw new CaseWorkspaceRepositoryError("CASE_WORKSPACE_IDEMPOTENCY_IN_PROGRESS");
    }
    return createdCase(row);
  }

  const student = await transaction.query(
    "SELECT id FROM crm_students WHERE id = $1 AND status = 'active' FOR SHARE",
    [input.studentId],
  );
  if (student.rowCount !== 1) {
    throw new CaseWorkspaceRepositoryError("CASE_WORKSPACE_STUDENT_NOT_FOUND");
  }
  const binding = await transaction.query<{
    id: string;
    membership_id: string;
    user_id: string;
    role: "founder" | "advisor";
  }>(
    `SELECT role_binding.id, role_binding.membership_id, role_binding.user_id,
            role_binding.role
       FROM access_role_bindings AS role_binding
       JOIN access_organization_memberships AS membership
         ON membership.id = role_binding.membership_id
        AND membership.organization_id = role_binding.organization_id
      WHERE role_binding.id = $1
        AND role_binding.role IN ('founder', 'advisor')
        AND role_binding.status = 'active'
        AND membership.status = 'active'
        AND identity_user_is_active(role_binding.user_id)
        AND access_organization_is_active(role_binding.organization_id)
        AND ($2::boolean = false OR role_binding.user_id = $3)
      FOR SHARE OF role_binding, membership`,
    [input.primaryRoleBindingId, input.actorRole === "advisor", input.actorUserId],
  );
  const selectedBinding = binding.rows[0];
  if (!selectedBinding) {
    throw new CaseWorkspaceRepositoryError("CASE_WORKSPACE_BINDING_INACTIVE");
  }
  const manifest = await transaction.query(
    "SELECT $1::uuid AS id WHERE cases_manifest_is_approved($1::uuid)",
    [input.manifestId],
  );
  if (manifest.rowCount !== 1) {
    throw new CaseWorkspaceRepositoryError("CASE_WORKSPACE_MANIFEST_NOT_APPROVED");
  }

  await transaction.query(
    `INSERT INTO cases_service_cases
      (id, organization_id, student_id, case_number, application_type, intake_year,
       admission_type, primary_role_binding_id, primary_membership_id, primary_user_id,
       primary_role, stage)
     VALUES ($1,$2,$3,$4,'k12',$5,$6,$7,$8,$9,$10,'signed')`,
    [input.serviceCaseId, input.organizationId, input.studentId, input.caseNumber,
      input.intakeYear, input.admissionType, selectedBinding.id,
      selectedBinding.membership_id, selectedBinding.user_id, selectedBinding.role],
  );
  await transaction.query(
    `INSERT INTO cases_assessments
      (id, organization_id, service_case_id, manifest_id, status)
     VALUES ($1,$2,$3,$4,'draft')`,
    [input.assessmentId, input.organizationId, input.serviceCaseId, input.manifestId],
  );
  await appendAtomicMutationEffects(transaction, input.effects);
  await transaction.query(
    `UPDATE shared_idempotency_records
        SET state = 'completed', result_reference = $5, response_hash = $4,
            record_version = record_version + 1,
            updated_at = to_timestamp($6 / 1000.0)
      WHERE organization_id = $1 AND actor_user_id = $2
        AND operation = 'cases.create_existing_student' AND idempotency_key = $3
        AND request_hash = $4 AND state = 'in_progress'`,
    [input.organizationId, input.actorUserId, input.idempotencyKey, input.requestHash,
      input.serviceCaseId, input.createdAtMs],
  );
  return Object.freeze({
    id: input.serviceCaseId,
    caseNumber: input.caseNumber,
    studentId: input.studentId,
    assessmentId: input.assessmentId,
    intakeYear: input.intakeYear,
    admissionType: input.admissionType,
    stage: "signed",
    manifestId: input.manifestId,
    recordVersion: 1,
  });
}

function caseSelect(condition: string): string {
  return `SELECT service_case.id, service_case.case_number, service_case.student_id,
                 student.display_name AS student_name, service_case.intake_year,
                 service_case.admission_type, service_case.stage, service_case.updated_at,
                 service_case.primary_role
            FROM cases_service_cases AS service_case
            JOIN crm_students AS student
              ON student.id = service_case.student_id
             AND student.organization_id = service_case.organization_id
           WHERE ${condition}`;
}

function toListItem(row: CaseRow): CaseWorkspaceListItem {
  return Object.freeze({
    id: row.id,
    caseNumber: row.case_number,
    studentId: row.student_id,
    studentName: row.student_name,
    intakeYear: row.intake_year,
    admissionType: row.admission_type,
    stage: row.stage,
    updatedAt: new Date(row.updated_at).toISOString(),
    primaryRole: row.primary_role,
  });
}

function createdCase(row: CaseRow): CreatedExistingStudentCase {
  return Object.freeze({
    id: row.id,
    caseNumber: row.case_number,
    studentId: row.student_id,
    assessmentId: row.assessment_id!,
    intakeYear: row.intake_year,
    admissionType: row.admission_type,
    stage: "signed",
    manifestId: row.manifest_id!,
    recordVersion: 1,
  });
}

function isUniqueViolation(error: unknown): error is { code: "23505" } {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}
