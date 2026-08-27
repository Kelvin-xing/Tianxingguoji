import { F3CaseSection } from '@/components/cases/F3CaseSection'
export default async function CloseCasePage({ params }: { params: Promise<{ caseId: string }> }) { const { caseId } = await params; return <div className="max-w-4xl mx-auto space-y-6"><h2 className="page-title">人工结案</h2><F3CaseSection caseId={caseId} section="close" /></div> }
