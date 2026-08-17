import { mockCases } from './mock-cases.ts'
import type { CaseRecord } from '../../../types/index.ts'

export interface CaseWorkspaceReadAdapter {
  listCases(): CaseRecord[]
  getCase(id: string): CaseRecord | undefined
}

export const previewCaseWorkspaceAdapter: CaseWorkspaceReadAdapter = {
  listCases: () => mockCases,
  getCase: (id) => mockCases.find((record) => record.id === id),
}
