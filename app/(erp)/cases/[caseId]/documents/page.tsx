import { CaseDocumentsPanel } from '@/components/documents/CaseDocumentsPanel'
export default async function CaseDocumentsPage({ params }: { params: Promise<{ caseId: string }> }) {
  const { caseId } = await params;
  return <div className="max-w-6xl mx-auto space-y-6"><h2 className="page-title">案件文件</h2><CaseDocumentsPanel caseId={caseId}/></div>;
}
