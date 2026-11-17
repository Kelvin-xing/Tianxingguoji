import { InterviewInvitationsPanel } from '@/components/cases/InterviewInvitationsPanel'
import { CaseSubpage } from '@/components/cases/CaseSubpage'

export default async function CaseInterviewsPage({ params }: { params: Promise<{ caseId: string }> }) {
  const { caseId } = await params
  return (
    <CaseSubpage caseId={caseId} current="interviews">
      <InterviewInvitationsPanel caseId={caseId} />
    </CaseSubpage>
  )
}
