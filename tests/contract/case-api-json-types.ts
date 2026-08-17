import type { JsonValue } from '@/modules/shared/presentation/api-contract'
import type { CaseListItem, CaseOptions, CreatedCase } from '@/modules/cases/infrastructure/legacy-service'

// These assignments are compile-time guards for the API envelope boundary.
export const caseOptionsEnvelope: JsonValue = { options: {} as CaseOptions }
export const caseListEnvelope: JsonValue = { cases: [] as CaseListItem[] }
export const createdCaseEnvelope: JsonValue = { case: {} as CreatedCase }
