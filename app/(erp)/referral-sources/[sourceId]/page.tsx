import { ReferralSourceDetail } from '@/components/crm/ReferralSourceDetail'

export default async function ReferralSourceDetailPage({params}:{params:Promise<{sourceId:string}>}) {
  const {sourceId}=await params
  return <ReferralSourceDetail sourceId={sourceId}/>
}
