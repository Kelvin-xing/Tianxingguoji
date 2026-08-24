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
  primaryRole: 'advisor'
}

export type CaseOptions = {
  students: Array<{ id: string; displayName: string }>
  primaryBindings: Array<{ id: string; role: 'advisor'; label: string }>
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

export async function createCase(
  actor: SessionActor,
  input: CreateCaseInput,
): Promise<CreatedCase> {
  void actor
  void input
  throw new CaseCommandError('FORBIDDEN')
}

export async function listCases(actor: SessionActor): Promise<CaseListItem[]> {
  void actor
  throw new CaseCommandError('FORBIDDEN')
}

export async function getCaseDetail(
  actor: SessionActor,
  caseId: string,
): Promise<CaseDetail | undefined> {
  void actor
  void caseId
  throw new CaseCommandError('FORBIDDEN')
}

export async function listCaseOptions(actor: SessionActor): Promise<CaseOptions> {
  void actor
  throw new CaseCommandError('FORBIDDEN')
}
