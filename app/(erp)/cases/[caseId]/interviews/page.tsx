import { F3CaseSection } from '@/components/cases/F3CaseSection'
export default async function InterviewsPage({ params }: { params: Promise<{ caseId: string }> }) { const { caseId } = await params; return <div className="max-w-6xl mx-auto space-y-6"><h2 className="page-title">面试辅助</h2><F3CaseSection caseId={caseId} section="interviews" /></div> }
