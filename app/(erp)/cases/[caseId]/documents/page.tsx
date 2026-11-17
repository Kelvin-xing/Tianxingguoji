import { CaseDocumentsPanel } from '@/components/documents/CaseDocumentsPanel'
import { CaseSubpage } from '@/components/cases/CaseSubpage'

export default async function CaseDocumentsPage({ params }: { params: Promise<{ caseId: string }> }) {
  const { caseId } = await params
  return (
    <CaseSubpage caseId={caseId} current="documents">
      <CaseDocumentsPanel caseId={caseId} />
    </CaseSubpage>
  )
}
