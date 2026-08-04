import { mockCases } from '@/lib/mock/cases'
import type { CaseRecord } from '@/types'

export interface CaseWorkspaceReadAdapter {
  listCases(): CaseRecord[]
  getCase(id: string): CaseRecord | undefined
}

export const previewCaseWorkspaceAdapter: CaseWorkspaceReadAdapter = {
  listCases: () => mockCases,
  getCase: (id) => mockCases.find((record) => record.id === id),
}
