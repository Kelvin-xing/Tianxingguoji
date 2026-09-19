import { SchoolDetail } from '@/components/schools/SchoolDetail'

export default async function SchoolDetailPage({ params }: { params: Promise<{ schoolId: string }> }) {
  const { schoolId } = await params
  return <SchoolDetail schoolId={schoolId} />
}
