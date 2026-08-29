import { F3CaseSection } from '@/components/cases/F3CaseSection'
 export default async function ApplicationsPage({ params }: { params: Promise<{ caseId: string }> }) { const { caseId } = await params; return <div className="max-w-6xl mx-auto space-y-6"><h2 className="page-title">逐校申請</h2><F3CaseSection caseId={caseId} section="applications" /></div> }
