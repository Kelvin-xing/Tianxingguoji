import { StudentDetailWorkspace } from '@/components/crm/StudentDetailWorkspace'

export default async function StudentDetailPage({ params }: { params: Promise<{ studentId: string }> }) {
  const { studentId } = await params
  return <StudentDetailWorkspace studentId={studentId} />
}
