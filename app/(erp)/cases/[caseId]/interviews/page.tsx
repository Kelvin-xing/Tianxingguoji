import { InterviewInvitationsPanel } from '@/components/cases/InterviewInvitationsPanel'
export default async function InterviewsPage({ params }: { params: Promise<{ caseId: string }> }) {
  const { caseId } = await params;
  return <div className="max-w-6xl mx-auto space-y-6"><h2 className="page-title">面試支援</h2><InterviewInvitationsPanel caseId={caseId} /></div>
}
