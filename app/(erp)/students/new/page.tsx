import Link from 'next/link'

import { StudentCreateForm } from '@/components/crm/StudentCreateForm'

export default function NewStudentPage() {
  return <div className="max-w-5xl mx-auto space-y-6"><div className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}><Link href="/students" className="quiet-link">學生</Link><span>/</span><span>建立資料</span></div><section><div className="eyebrow">CRM · 學生資料</div><h2 className="page-title">建立學生與主要監護人</h2><p className="page-subtitle">先查詢已有監護人；確認不存在後才建立。</p></section><StudentCreateForm /></div>
}
