import Link from 'next/link'

import { StudentIntake } from '@/components/crm/StudentIntake'

export default function NewStudentPage() {
  return <div className="max-w-5xl mx-auto space-y-6"><div className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}><Link href="/students" className="quiet-link">Student</Link><span>/</span><span>新建</span></div><section><div className="eyebrow">CRM · Atomic intake</div><h2 className="page-title">新建 Student 与 Primary Guardian</h2><p className="page-subtitle">先做瞬时重复预检，再由服务端以一个 CRM 命令保存 Student、Guardian 与关系。</p></section><StudentIntake /></div>
}
