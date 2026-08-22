import { DuplicateCandidateReview } from '@/components/crm/DuplicateCandidateReview'

export default async function DuplicateCandidatePage({
  params,
}: {
  readonly params: Promise<{ readonly candidateId: string }>
}) {
  const { candidateId } = await params
  return <DuplicateCandidateReview candidateId={candidateId} />
}
