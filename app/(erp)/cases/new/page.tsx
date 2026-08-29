import Link from 'next/link'

import { CaseIntakeWorkspace } from '@/components/crm/CaseIntakeWorkspace'

export default function NewCasePage() { return <div className="max-w-5xl mx-auto space-y-6"><div className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}><Link href="/cases" className="quiet-link">案件</Link><span>/</span><span>建立案件</span></div><section><div className="eyebrow">CRM · 案件</div><h2 className="page-title">建立案件</h2><p className="page-subtitle">為已有學生建立案件，並完成入學設定與主要顧問指派。</p></section><CaseIntakeWorkspace /></div> }
