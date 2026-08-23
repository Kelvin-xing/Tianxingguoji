import { ReferralSourceDetail } from '@/components/crm/ReferralSourceDetail'

export default async function ReferralSourceDetailPage({
  params,
}: {
  readonly params: Promise<{ readonly sourceId: string }>;
}) {
  const { sourceId } = await params
  return <ReferralSourceDetail sourceId={sourceId} />
}
