import { CaseCreateForm } from '@/components/cases/CaseCreateForm'

export default async function NewCasePage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly student?: string | string[] }>
}) {
  const { student } = await searchParams
  return <CaseCreateForm preselectedStudentId={typeof student === 'string' ? student : undefined} />
}
