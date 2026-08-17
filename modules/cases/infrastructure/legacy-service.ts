import { randomBytes, randomUUID } from 'node:crypto'
import { evaluateServiceCaseCreation } from '../domain/contract.ts'
import { withAuthTransaction, type DatabaseClient } from '../../identity/server.ts'
import type { SessionActor } from '../../identity/server.ts'
import type { CaseRecord, CaseStage } from '../../../types/index.ts'

export interface CreateCaseInput {
  studentId: string
  intakeYear: number
  admissionType: string
  manifestId: string
  primaryRoleBindingId?: string
}

export type CreatedCase = {
  id: string
  caseNumber: string
  studentId: string
  intakeYear: number
  admissionType: string
  stage: 'signed'
  manifestId: string
}

export type CaseListItem = {
  id: string
  caseNumber: string
  studentId: string
  studentName: string
  intakeYear: number
  admissionType: string
  stage: CaseStage
  updatedAt: string
  primaryRole: 'founder' | 'advisor'
}

export type CaseOptions = {
  students: Array<{ id: string; displayName: string }>
  primaryBindings: Array<{ id: string; role: 'founder' | 'advisor'; label: string }>
  manifests: Array<{ id: string; compositionVersion: string; label: string }>
}

export type CaseDetail = CaseRecord

export type CaseCommandErrorCode =
  | 'VALIDATION_FAILED'
  | 'FORBIDDEN'
  | 'STUDENT_NOT_FOUND'
  | 'MANIFEST_NOT_APPROVED'
  | 'DUPLICATE_CASE'

export class CaseCommandError extends Error {
  readonly code: CaseCommandErrorCode

  constructor(code: CaseCommandErrorCode) {
    super('The case command could not be completed')
    this.name = 'CaseCommandError'
    this.code = code
  }
}

interface StudentRow {
  id: string
  organization_id: string
  status: 'active' | 'pending_delete' | 'purged'
}

interface RoleBindingRow {
  id: string
  organization_id: string
  membership_id: string
  user_id: string
  role: 'founder' | 'admin' | 'advisor' | 'data_reviewer' | 'contractor'
  status: 'active' | 'revoked'
  membership_status: 'invited' | 'active' | 'disabled'
  user_status: 'invited' | 'active' | 'disabled'
  organization_status: 'active' | 'disabled'
}

interface ManifestRow {
  id: string
  status: 'candidate' | 'approved' | 'retired'
}

interface CaseListRow {
  id: string
  case_number: string
  student_id: string
  student_name: string
  intake_year: number
  admission_type: string
  stage: CaseStage
  updated_at: Date | string
  primary_role: 'founder' | 'advisor'
}

interface StudentOptionRow {
  id: string
  display_name: string
}

interface PrimaryBindingOptionRow {
  id: string
  role: 'founder' | 'advisor'
  normalized_email: string
}

interface ManifestOptionRow {
  id: string
  composition_version: string
}

interface CaseDetailRow {
  id: string
  case_number: string
  student_id: string
  student_name: string
  intake_year: number
  admission_type: string
  stage: CaseDetail['stage']
  updated_at: Date | string
  primary_role: 'founder' | 'advisor'
  advisor: string
  assessment_status: CaseDetail['assessment_status'] | null
  manifest_status: CaseDetail['manifest_status'] | null
}

export async function createCase(
  actor: SessionActor,
  input: CreateCaseInput,
): Promise<CreatedCase> {
  validateCreateCaseInput(input)

  return withAuthTransaction(async (client) => {
    const student = await client.query<StudentRow>(
      `SELECT id, organization_id, status
         FROM crm_students
        WHERE id = $1
          AND organization_id = $2
        FOR SHARE`,
      [input.studentId, actor.organizationId],
    )
    const studentRow = student.rows[0]
    if (!studentRow) throw new CaseCommandError('STUDENT_NOT_FOUND')

    const targetBindingId = selectPrimaryRoleBinding(actor, input)
    const binding = await client.query<RoleBindingRow>(
      `SELECT
         role_binding.id,
         role_binding.organization_id,
         role_binding.membership_id,
         role_binding.user_id,
         role_binding.role,
         role_binding.status,
         membership.status AS membership_status,
         identity_user.status AS user_status,
         organization.status AS organization_status
       FROM access_role_bindings AS role_binding
       JOIN access_organization_memberships AS membership
         ON membership.id = role_binding.membership_id
        AND membership.organization_id = role_binding.organization_id
        AND membership.user_id = role_binding.user_id
       JOIN identity_users AS identity_user ON identity_user.id = role_binding.user_id
       JOIN access_organizations AS organization ON organization.id = role_binding.organization_id
      WHERE role_binding.id = $1
        AND role_binding.organization_id = $2
      FOR SHARE OF role_binding, membership, identity_user, organization`,
      [targetBindingId, actor.organizationId],
    )
    const bindingRow = binding.rows[0]
    if (
      !bindingRow ||
      bindingRow.organization_status !== 'active' ||
      bindingRow.membership_status !== 'active' ||
      bindingRow.user_status !== 'active'
    ) throw new CaseCommandError('FORBIDDEN')

    const manifest = await client.query<ManifestRow>(
      `SELECT id, status
         FROM cases_schema_manifests
        WHERE id = $1
          AND application_type = 'k12'
        FOR SHARE`,
      [input.manifestId],
    )
    const manifestRow = manifest.rows[0]
    if (!manifestRow || manifestRow.status !== 'approved') {
      throw new CaseCommandError('MANIFEST_NOT_APPROVED')
    }

    const decision = evaluateServiceCaseCreation({
      applicationType: 'k12',
      organizationId: actor.organizationId,
      studentOrganizationId: studentRow.organization_id,
      studentStatus: studentRow.status,
      primaryRole: bindingRow.role,
      primaryOrganizationId: bindingRow.organization_id,
      primaryBindingStatus: bindingRow.status,
      manifestStatus: manifestRow.status,
      initialStage: 'signed',
    })
    if (!decision.allowed) {
      if (decision.code === 'STUDENT_NOT_ACTIVE') throw new CaseCommandError('STUDENT_NOT_FOUND')
      if (decision.code === 'MANIFEST_NOT_APPROVED') throw new CaseCommandError('MANIFEST_NOT_APPROVED')
      throw new CaseCommandError('FORBIDDEN')
    }

    const id = randomUUID()
    const caseNumber = createCaseNumber(input.intakeYear)
    try {
      await client.query(
        `INSERT INTO cases_service_cases (
           id,
           organization_id,
           student_id,
           case_number,
           application_type,
           intake_year,
           admission_type,
           primary_role_binding_id,
           primary_membership_id,
           primary_user_id,
           primary_role,
           stage,
           created_at,
           updated_at
         ) VALUES ($1, $2, $3, $4, 'k12', $5, $6, $7, $8, $9, $10, 'signed', transaction_timestamp(), transaction_timestamp())`,
        [
          id,
          actor.organizationId,
          input.studentId,
          caseNumber,
          input.intakeYear,
          input.admissionType,
          bindingRow.id,
          bindingRow.membership_id,
          bindingRow.user_id,
          bindingRow.role,
        ],
      )
      await client.query(
        `INSERT INTO cases_assessments (
           id,
           organization_id,
           service_case_id,
           manifest_id,
           status,
           created_at,
           updated_at
         ) VALUES ($1, $2, $3, $4, 'draft', transaction_timestamp(), transaction_timestamp())`,
        [randomUUID(), actor.organizationId, id, input.manifestId],
      )
    } catch (error) {
      if (isUniqueViolation(error)) throw new CaseCommandError('DUPLICATE_CASE')
      throw error
    }

    return {
      id,
      caseNumber,
      studentId: input.studentId,
      intakeYear: input.intakeYear,
      admissionType: input.admissionType,
      stage: 'signed',
      manifestId: input.manifestId,
    }
  })
}

export async function listCases(actor: SessionActor): Promise<CaseListItem[]> {
  return withAuthTransaction(async (client) => {
    const result = await client.query<CaseListRow>(
      `SELECT
         service_case.id,
         service_case.case_number,
         service_case.student_id,
         COALESCE(student.display_name, '') AS student_name,
         service_case.intake_year,
         service_case.admission_type,
         service_case.stage,
         service_case.updated_at,
         service_case.primary_role
       FROM cases_service_cases AS service_case
       JOIN crm_students AS student
         ON student.id = service_case.student_id
        AND student.organization_id = service_case.organization_id
      WHERE service_case.organization_id = $1
        AND ($2 IN ('founder', 'admin') OR service_case.primary_user_id = $3)
      ORDER BY service_case.updated_at DESC, service_case.id DESC`,
      [actor.organizationId, actor.role, actor.userId],
    )
    return result.rows.map((row) => ({
      id: row.id,
      caseNumber: row.case_number,
      studentId: row.student_id,
      studentName: row.student_name,
      intakeYear: row.intake_year,
      admissionType: row.admission_type,
      stage: row.stage,
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
      primaryRole: row.primary_role,
    }))
  })
}

export async function getCaseDetail(
  actor: SessionActor,
  caseId: string,
): Promise<CaseDetail | undefined> {
  if (!isUuid(caseId)) return undefined

  return withAuthTransaction(async (client) => {
    const result = await client.query<CaseDetailRow>(
      `SELECT
         service_case.id,
         service_case.case_number,
         service_case.student_id,
         COALESCE(student.display_name, '') AS student_name,
         service_case.intake_year,
         service_case.admission_type,
         service_case.stage,
         service_case.updated_at,
         service_case.primary_role,
         primary_user.normalized_email AS advisor,
         assessment.status AS assessment_status,
         manifest.status AS manifest_status
       FROM cases_service_cases AS service_case
       JOIN crm_students AS student
         ON student.id = service_case.student_id
        AND student.organization_id = service_case.organization_id
       JOIN identity_users AS primary_user ON primary_user.id = service_case.primary_user_id
       LEFT JOIN cases_assessments AS assessment
         ON assessment.service_case_id = service_case.id
        AND assessment.organization_id = service_case.organization_id
       LEFT JOIN cases_schema_manifests AS manifest ON manifest.id = assessment.manifest_id
      WHERE service_case.id = $1
        AND service_case.organization_id = $2
        AND ($3 IN ('founder', 'admin') OR service_case.primary_user_id = $4)
      LIMIT 1`,
      [caseId, actor.organizationId, actor.role, actor.userId],
    )
    const row = result.rows[0]
    if (!row) return undefined
    const updatedAt = row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at
    const assessmentStatus = row.assessment_status || 'draft'
    const manifestStatus = row.manifest_status || 'candidate'

    return {
      id: row.id,
      case_number: row.case_number,
      student_id: row.student_id,
      student_name: row.student_name,
      student_name_en: '',
      application_type: 'k12',
      intake_year: row.intake_year,
      admission_type: row.admission_type as CaseDetail['admission_type'],
      stage: row.stage,
      stage_label: caseStageLabel(row.stage),
      advisor: row.advisor,
      advisor_role: row.primary_role,
      assessment_status: assessmentStatus,
      manifest_status: manifestStatus,
      blockers: manifestStatus === 'approved' ? [] : ['尚未有 approved manifest'],
      next_action: manifestStatus === 'approved' ? '完成 Assessment' : '確認 approved manifest',
      next_action_date: updatedAt.slice(0, 10),
      updated_at: updatedAt,
      school_targets: [],
      tasks: [],
      documents: [],
      activity: [],
    }
  })
}

export async function listCaseOptions(actor: SessionActor): Promise<CaseOptions> {
  return withAuthTransaction(async (client) => {
    const students = await client.query<StudentOptionRow>(
      `SELECT id, COALESCE(display_name, '') AS display_name
         FROM crm_students
        WHERE organization_id = $1
          AND status = 'active'
        ORDER BY lower(COALESCE(display_name, '')), id`,
      [actor.organizationId],
    )
    const bindings = await client.query<PrimaryBindingOptionRow>(
      `SELECT
         role_binding.id,
         role_binding.role,
         identity_user.normalized_email
       FROM access_role_bindings AS role_binding
       JOIN access_organization_memberships AS membership
         ON membership.id = role_binding.membership_id
        AND membership.organization_id = role_binding.organization_id
        AND membership.user_id = role_binding.user_id
       JOIN identity_users AS identity_user ON identity_user.id = role_binding.user_id
      WHERE role_binding.organization_id = $1
        AND role_binding.role IN ('founder', 'advisor')
        AND role_binding.status = 'active'
        AND membership.status = 'active'
        AND identity_user.status = 'active'
      ORDER BY CASE role_binding.role WHEN 'founder' THEN 1 ELSE 2 END, identity_user.normalized_email`,
      [actor.organizationId],
    )
    const manifests = await client.query<ManifestOptionRow>(
      `SELECT id, composition_version
         FROM cases_schema_manifests
        WHERE application_type = 'k12'
          AND status = 'approved'
        ORDER BY composition_version, id`,
    )

    return {
      students: students.rows.map((row) => ({ id: row.id, displayName: row.display_name })),
      primaryBindings: bindings.rows
        .filter((row) => actor.role !== 'advisor' || row.id === actor.roleBindingId)
        .map((row) => ({
          id: row.id,
          role: row.role,
          label: `${row.normalized_email} · ${row.role === 'founder' ? 'Founder' : 'Advisor'}`,
        })),
      manifests: manifests.rows.map((row) => ({
        id: row.id,
        compositionVersion: row.composition_version,
        label: `${row.composition_version} · approved`,
      })),
    }
  })
}

function selectPrimaryRoleBinding(actor: SessionActor, input: CreateCaseInput): string {
  if (actor.role === 'advisor') {
    if (input.primaryRoleBindingId && input.primaryRoleBindingId !== actor.roleBindingId) {
      throw new CaseCommandError('FORBIDDEN')
    }
    return actor.roleBindingId
  }
  if (input.primaryRoleBindingId) return input.primaryRoleBindingId
  if (actor.role === 'founder') return actor.roleBindingId
  throw new CaseCommandError('VALIDATION_FAILED')
}

function validateCreateCaseInput(input: CreateCaseInput): void {
  if (
    !isUuid(input.studentId) ||
    !isUuid(input.manifestId) ||
    (input.primaryRoleBindingId !== undefined && !isUuid(input.primaryRoleBindingId)) ||
    !Number.isSafeInteger(input.intakeYear) ||
    input.intakeYear < 2000 ||
    input.intakeYear > 2200 ||
    !input.admissionType.trim() ||
    input.admissionType.trim().length > 80
  ) {
    throw new CaseCommandError('VALIDATION_FAILED')
  }
}

function createCaseNumber(intakeYear: number): string {
  const year = String(intakeYear).slice(-2)
  return `HK${year}-${randomBytes(4).toString('hex').toUpperCase()}`
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505'
}

function caseStageLabel(stage: CaseDetail['stage']): string {
  const labels: Record<CaseDetail['stage'], string> = {
    signed: '已簽約',
    background_collection: '收集背景資料',
    school_selection_confirmed: '已確認選校',
    interview_preparation: '面試準備',
    application_submitted: '已提交申請',
    awaiting_result: '等待結果',
    offer_confirmed: 'Offer 已確認',
    closed: '已結案',
  }
  return labels[stage]
}
