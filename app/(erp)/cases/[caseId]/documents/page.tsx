import { DocumentWorkspace } from '@/components/documents/DocumentWorkspace'
export default async function CaseDocumentsPage({ params }: { params: Promise<{ caseId: string }> }) { const { caseId } = await params; return <div className="max-w-6xl mx-auto space-y-6"><h2 className="page-title">Case 文件</h2><DocumentWorkspace caseId={caseId} /></div> }
