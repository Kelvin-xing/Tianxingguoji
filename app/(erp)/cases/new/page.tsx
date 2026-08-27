import Link from 'next/link'

import { CaseIntakeWorkspace } from '@/components/crm/CaseIntakeWorkspace'

export default function NewCasePage() { return <div className="max-w-5xl mx-auto space-y-6"><div className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}><Link href="/cases" className="quiet-link">Cases</Link><span>/</span><span>New intake</span></div><section><div className="eyebrow">CRM · Cases</div><h2 className="page-title">建立 Case</h2><p className="page-subtitle">CRM Student 建档与 Case 创建分开提交；Assessment manifest 由服务端绑定，页面不会选择 manifest。</p></section><CaseIntakeWorkspace /></div> }
