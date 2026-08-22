import { StudentDetailView } from '@/components/crm/StudentDetailView'

export default async function StudentDetailPage({
  params,
}: {
  readonly params: Promise<{ readonly studentId: string }>;
}) {
  const { studentId } = await params
  return <StudentDetailView studentId={studentId} />
}
