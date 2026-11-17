import Link from 'next/link'
import { StudentCreateForm } from '@/components/crm/StudentCreateForm'
import { Page, PageHeader } from '@/components/ui/standard'

export default function NewStudentPage() {
  return <Page><Link href="/students" className="ui-back">學生</Link><PageHeader title="建立學生與主要監護人" description="先查詢已有監護人；確認不存在後才建立。" /><StudentCreateForm /></Page>
}
