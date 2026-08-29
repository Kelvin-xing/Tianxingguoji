import "server-only";

import { appendAtomicMutationEffects } from "../../audit/server.ts";
import { hashRequestPayload } from "../../shared/public.ts";
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
  workflow_status: CaseWorkspaceListItem["workflowStatus"];
  has_submitted_target: boolean;
  updated_at: Date | string;
  primary_role: "advisor";
  student_status: string;
  primary_user_id?: string;
  assessment_id?: string;
  assessment_status?: CaseWorkspaceDetail["assessmentStatus"];
  manifest_id?: string;
  primary_role_binding_id?: string;
  primary_display_name?: string | null;
  primary_email?: string | null;
  record_version: number | string;
}

export class PostgresqlCaseWorkspaceRepository implements CaseWorkspaceRepository {
  private readonly database: PostgreSqlAdapter;

  constructor(database: PostgreSqlAdapter) {
    this.database = database;
  }

  listCases(input: Parameters<CaseWorkspaceRepository["listCases"]>[0]) {
    return this.database.transaction(input, async (transaction) => {
      await assertCurrentWorkspaceActor(transaction, input);
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
      await assertCurrentWorkspaceActor(transaction, input);
      const values = input.actorRole === "advisor"
        ? [input.caseId, input.actorUserId]
        : [input.caseId];
      const actorFilter = input.actorRole === "advisor"
        ? "service_case.id = $1 AND service_case.primary_user_id = $2"
        : "service_case.id = $1";
      const result = await transaction.query<CaseRow>(
        `SELECT service_case.id, service_case.case_number, service_case.student_id,
                student.display_name AS student_name, student.status AS student_status,
                service_case.intake_year,
                service_case.admission_type, service_case.stage, service_case.workflow_status,
                service_case.updated_at,
                service_case.primary_role, service_case.primary_user_id,
                service_case.primary_role_binding_id,
                primary_identity.normalized_email AS primary_email,
                primary_profile.display_name AS primary_display_name,
                service_case.record_version, assessment.id AS assessment_id,
                assessment.status AS assessment_status, assessment.manifest_id,
                EXISTS (
                  SELECT 1 FROM cases_school_targets AS target
                   WHERE target.organization_id = service_case.organization_id
                     AND target.service_case_id = service_case.id
                     AND target.state IN (
                       'submitted', 'interview', 'waitlisted', 'accepted',
                       'offer_confirmed', 'offer_declined', 'rejected'
                     )
                ) AS has_submitted_target
           FROM cases_service_cases AS service_case
           JOIN crm_students AS student
             ON student.id = service_case.student_id
            AND student.organization_id = service_case.organization_id
           JOIN cases_assessments AS assessment
             ON assessment.service_case_id = service_case.id
            AND assessment.organization_id = service_case.organization_id
           LEFT JOIN access_role_bindings AS primary_binding
             ON primary_binding.id = service_case.primary_role_binding_id
            AND primary_binding.organization_id = service_case.organization_id
            AND primary_binding.user_id = service_case.primary_user_id
           LEFT JOIN access_employee_profiles AS primary_profile
             ON primary_profile.membership_id = primary_binding.membership_id
            AND primary_profile.organization_id = primary_binding.organization_id
           LEFT JOIN identity_users AS primary_identity
             ON primary_identity.id = service_case.primary_user_id
          WHERE ${actorFilter}`,
        values,
      );
      const row = result.rows[0];
      if (!row || !row.assessment_id || !row.assessment_status || !row.manifest_id ||
          !row.primary_role_binding_id || !row.primary_user_id ||
          row.record_version === undefined) return null;
      return Object.freeze({
        ...toListItem(row),
        assessmentId: row.assessment_id,
        assessmentStatus: row.assessment_status,
        manifestId: row.manifest_id,
        primaryBindingLabel: formatAdvisorLabel(row.primary_display_name, row.primary_email),
        primaryUserId: row.primary_user_id,
      }) satisfies CaseWorkspaceDetail;
    });
  }

  listOptions(input: Parameters<CaseWorkspaceRepository["listOptions"]>[0]) {
    return this.database.transaction(input, async (transaction) => {
      await assertCurrentWorkspaceActor(transaction, input);
      const students = await transaction.query<{ id: string; display_name: string }>(
          `SELECT id, display_name FROM crm_students
            WHERE status = 'active' ORDER BY display_name, id`,
        );
      const bindings = await transaction.query<{
        id: string;
        role: "advisor";
        user_id: string;
        normalized_email: string;
        display_name: string | null;
      }>(
          `SELECT role_binding.id, role_binding.role, role_binding.user_id,
                  identity_user.normalized_email,
                  employee_profile.display_name
             FROM access_role_bindings AS role_binding
             JOIN access_organization_memberships AS membership
               ON membership.id = role_binding.membership_id
              AND membership.organization_id = role_binding.organization_id
             JOIN identity_users AS identity_user
               ON identity_user.id = role_binding.user_id
             LEFT JOIN access_employee_profiles AS employee_profile
               ON employee_profile.membership_id = membership.id
              AND employee_profile.organization_id = membership.organization_id
            WHERE role_binding.role = 'advisor'
              AND role_binding.status = 'active'
              AND membership.status = 'active'
              AND identity_user_is_active(role_binding.user_id)
              AND access_organization_is_active(role_binding.organization_id)
              AND ($1::boolean = false OR role_binding.user_id = $2)
            ORDER BY COALESCE(NULLIF(BTRIM(employee_profile.display_name), ''), ''),
              identity_user.normalized_email, role_binding.id`,
          [input.actorRole === "advisor", input.actorUserId],
        );
      const manifests = await transaction.query<{ id: string; composition_version: string }>(
          `SELECT id, composition_version
             FROM cases_list_approved_manifests()
            ORDER BY composition_version DESC, id`,
        );
      return Object.freeze({
        students: Object.freeze(students.rows.map((row) => Object.freeze({
          id: row.id,
          displayName: row.display_name,
        }))),
        primaryBindings: Object.freeze(bindings.rows.map((row) => Object.freeze({
          id: row.id,
          role: row.role,
          label: formatAdvisorLabel(
            row.display_name,
            row.normalized_email,
            row.user_id === input.actorUserId ? "我的 " : "",
          ),
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
        if (isActiveCaseDuplicateViolation(error)) {
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
    response_hash: string | null;
  }>(
    `SELECT request_hash, state, result_reference, response_hash
       FROM shared_idempotency_records
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
    const replay = await transaction.query<{
      service_case_id: string;
      to_record_version: number | string;
      primary_user_id: string;
      primary_role: string;
    } & Record<string, unknown>>(
      `SELECT transition_fact.service_case_id, transition_fact.to_record_version,
              service_case.primary_user_id, service_case.primary_role
         FROM cases_service_case_transition_facts AS transition_fact
         JOIN cases_service_cases AS service_case
           ON service_case.id = transition_fact.service_case_id
          AND service_case.organization_id = transition_fact.organization_id
        WHERE transition_fact.id = $1
          AND transition_fact.from_stage = 'signed'
          AND transition_fact.to_stage = 'background_collection'
          AND transition_fact.from_record_version = 1
          AND transition_fact.to_record_version = 2
        FOR SHARE OF service_case`,
      [storedReceipt.result_reference],
    );
    const row = replay.rows[0];
    if (!row) {
      throw new CaseWorkspaceRepositoryError("CASE_WORKSPACE_IDEMPOTENCY_IN_PROGRESS");
    }
    await assertCurrentCaseCreator(transaction, input);
    if (input.actorRole === "advisor" &&
        (row.primary_role !== "advisor" || row.primary_user_id !== input.actorUserId)) {
      throw new CaseWorkspaceRepositoryError("CASE_WORKSPACE_FORBIDDEN");
    }
    const replayResult = Object.freeze({
      id: row.service_case_id,
      recordVersion: Number(row.to_record_version),
    });
    if (storedReceipt.response_hash !== hashRequestPayload({
      id: replayResult.id,
      record_version: replayResult.recordVersion,
    })) {
      throw new CaseWorkspaceRepositoryError("CASE_WORKSPACE_IDEMPOTENCY_IN_PROGRESS");
    }
    return replayResult;
  }

  await assertCurrentCaseCreator(transaction, input);

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
        AND role_binding.role = 'advisor'
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
       primary_role, current_primary_advisor_assignment_id, stage, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'k12',$5,$6,$7,$8,$9,$10,$11,'signed',
       to_timestamp($12 / 1000.0),to_timestamp($12 / 1000.0))`,
    [input.serviceCaseId, input.organizationId, input.studentId, input.caseNumber,
      input.intakeYear, input.admissionType, selectedBinding.id,
      selectedBinding.membership_id, selectedBinding.user_id, selectedBinding.role,
      input.primaryAdvisorAssignmentId, input.createdAtMs],
  );
  await transaction.query(
    `INSERT INTO cases_primary_advisor_assignments
      (id, organization_id, service_case_id, advisor_role_binding_id, membership_id,
       advisor_user_id, advisor_role, starts_at, assignment_reason, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,'advisor',to_timestamp($7 / 1000.0),
       'case_creation',to_timestamp($7 / 1000.0),to_timestamp($7 / 1000.0))`,
    [input.primaryAdvisorAssignmentId, input.organizationId, input.serviceCaseId,
      selectedBinding.id, selectedBinding.membership_id, selectedBinding.user_id,
      input.createdAtMs],
  );
  await transaction.query(
    `INSERT INTO cases_assessments
      (id, organization_id, service_case_id, manifest_id, status)
     VALUES ($1,$2,$3,$4,'draft')`,
    [input.assessmentId, input.organizationId, input.serviceCaseId, input.manifestId],
  );
  const advanced = await transaction.query<{
    decision: string;
    result_stage: string | null;
    result_record_version: number | string | null;
  } & Record<string, unknown>>(
    `SELECT decision, result_stage, result_record_version
       FROM cases_advance_new_service_case($1,$2,$3,to_timestamp($4 / 1000.0))`,
    [input.serviceCaseId, input.actorRole, input.transitionFactId, input.createdAtMs],
  );
  const advancedRow = advanced.rows[0];
  if (
    advancedRow?.decision !== "allowed" ||
    advancedRow.result_stage !== "background_collection" ||
    Number(advancedRow.result_record_version) !== 2
  ) {
    throw new CaseWorkspaceRepositoryError("CASE_WORKSPACE_IDEMPOTENCY_IN_PROGRESS");
  }
  await appendAtomicMutationEffects(transaction, input.effects);
  const completed = await transaction.query(
    `UPDATE shared_idempotency_records
        SET state = 'completed', result_reference = $5, response_hash = $6,
            record_version = record_version + 1,
            updated_at = to_timestamp($7 / 1000.0)
      WHERE organization_id = $1 AND actor_user_id = $2
        AND operation = 'cases.create_existing_student' AND idempotency_key = $3
        AND request_hash = $4 AND state = 'in_progress'`,
    [input.organizationId, input.actorUserId, input.idempotencyKey, input.requestHash,
      input.transitionFactId, input.responseHash, input.createdAtMs],
  );
  if (completed.rowCount !== 1) {
    throw new CaseWorkspaceRepositoryError("CASE_WORKSPACE_IDEMPOTENCY_IN_PROGRESS");
  }
  return Object.freeze({
    id: input.serviceCaseId,
    recordVersion: 2,
  });
}

async function assertCurrentCaseCreator(
  transaction: PostgreSqlTransaction,
  input: Parameters<CaseWorkspaceRepository["createCase"]>[0],
): Promise<void> {
  await assertCurrentWorkspaceActor(transaction, input);
}

async function assertCurrentWorkspaceActor(
  transaction: PostgreSqlTransaction,
  input: Readonly<{
    organizationId: string;
    actorUserId: string;
    actorRole: string;
  }>,
): Promise<void> {
  if (input.actorRole !== "founder" && input.actorRole !== "advisor") {
    throw new CaseWorkspaceRepositoryError("CASE_WORKSPACE_FORBIDDEN");
  }
  const actor = await transaction.query(
    `SELECT role_binding.id
       FROM identity_users AS identity_user
       JOIN access_organization_memberships AS membership
         ON membership.organization_id = $1
        AND membership.user_id = identity_user.id
        AND membership.status = 'active'
       JOIN access_role_bindings AS role_binding
         ON role_binding.organization_id = membership.organization_id
        AND role_binding.membership_id = membership.id
        AND role_binding.user_id = identity_user.id
        AND role_binding.role = $3
        AND role_binding.status = 'active'
       JOIN access_organizations AS organization
         ON organization.id = membership.organization_id
        AND organization.status = 'active'
      WHERE identity_user.id = $2 AND identity_user.status = 'active'
      FOR SHARE OF identity_user, membership, role_binding, organization`,
    [input.organizationId, input.actorUserId, input.actorRole],
  );
  if (actor.rowCount !== 1) {
    throw new CaseWorkspaceRepositoryError("CASE_WORKSPACE_FORBIDDEN");
  }
}

function caseSelect(condition: string): string {
  return `SELECT service_case.id, service_case.case_number, service_case.student_id,
                 student.display_name AS student_name, student.status AS student_status,
                 service_case.intake_year,
                 service_case.admission_type, service_case.stage,
                 service_case.workflow_status, service_case.record_version,
                 service_case.updated_at, service_case.primary_role,
                 EXISTS (
                   SELECT 1 FROM cases_school_targets AS target
                    WHERE target.organization_id = service_case.organization_id
                      AND target.service_case_id = service_case.id
                      AND target.state IN (
                        'submitted', 'interview', 'waitlisted', 'accepted',
                        'offer_confirmed', 'offer_declined', 'rejected'
                      )
                 ) AS has_submitted_target
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
    workflowStatus: row.workflow_status,
    recordVersion: Number(row.record_version),
    availableWorkflowActions: workflowActions(row),
    updatedAt: new Date(row.updated_at).toISOString(),
    primaryRole: row.primary_role,
  });
}

function workflowActions(row: CaseRow): CaseWorkspaceListItem["availableWorkflowActions"] {
  if (row.student_status !== "active") return Object.freeze([]);
  if (row.workflow_status === "paused") return Object.freeze(["resume"] as const);
  if (
    row.workflow_status === "active" &&
    row.stage !== "signed" &&
    row.stage !== "closed" &&
    !row.has_submitted_target
  ) return Object.freeze(["pause"] as const);
  return Object.freeze([]);
}

function formatAdvisorLabel(
  displayName: string | null | undefined,
  email: string | null | undefined,
  prefix = "",
): string {
  const nickname = displayName?.trim() || "未设置昵称";
  const contact = email?.trim() || "未提供邮箱";
  return `${prefix}${nickname} · ${contact}`;
}

function isActiveCaseDuplicateViolation(
  error: unknown,
): error is { code: "23505"; constraint: "cases_service_cases_one_active_student_case_idx" } {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { readonly code?: unknown; readonly constraint?: unknown };
  return candidate.code === "23505" &&
    candidate.constraint === "cases_service_cases_one_active_student_case_idx";
}
