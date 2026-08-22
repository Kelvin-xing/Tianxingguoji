import Link from 'next/link'

import { StudentCreateForm } from '@/components/crm/StudentCreateForm'
import { Icon } from '@/components/workspace/Icon'

export default function NewStudentPage() {
  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
        <Link href="/students" className="quiet-link">學生與監護人</Link>
        <Icon name="chevron-right" size={14} />
        <span>新增學生</span>
      </div>
      <section>
        <div className="eyebrow">學生建檔</div>
        <h2 className="page-title">新增學生與主要監護人</h2>
        <p className="page-subtitle">一次保存學生基本資料、主要監護人及二者的聯絡關係。</p>
      </section>
      <StudentCreateForm />
    </div>
  )
}
