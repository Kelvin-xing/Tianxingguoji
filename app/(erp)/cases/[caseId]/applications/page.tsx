import { F3CaseSection } from '@/components/cases/F3CaseSection'
import { CaseSubpage } from '@/components/cases/CaseSubpage'

export default async function CaseApplicationsPage({ params }: { params: Promise<{ caseId: string }> }) {
  const { caseId } = await params
  return (
    <CaseSubpage caseId={caseId} current="applications">
      <F3CaseSection caseId={caseId} section="applications" />
    </CaseSubpage>
  )
}
