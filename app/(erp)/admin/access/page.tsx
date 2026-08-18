import { Icon } from '@/components/workspace/Icon'

const roles = [
  { name: 'Founder / Admin', scope: '全組織案件、學生、使用者與設定', tone: 'blue' },
  { name: 'Advisor', scope: '被分派案件、Student 360、任務與文件', tone: 'success' },
]

export default function AccessPage() {
  return (
    <div className="max-w-[1200px] mx-auto space-y-6">
      <section><div className="eyebrow">Administration · Identity</div><h2 className="page-title">Access</h2><p className="page-subtitle">管理內部角色邊界與 invite-only 登入入口。</p></section>
      <div className="preview-notice"><Icon name="shield" size={15} /><span>Cognito adapter boundary · 登入、invite、session refresh 和 server authorization 尚未接通。</span></div>
      <section className="workspace-section"><div className="flex items-center justify-between gap-3 mb-4"><div><h3 className="section-title">角色模型</h3><p className="section-detail">UI 顯示的角色不是權限證據；API 必須在 server 端重新驗證。</p></div><button type="button" className="secondary-button" disabled title="Invite API 尚未接通"><Icon name="mail" size={15} />邀請使用者</button></div><div className="grid grid-cols-1 md:grid-cols-2 gap-3">{roles.map((role) => <div key={role.name} className="selection-card selected"><span className={`work-icon ${role.tone}`}><Icon name={role.name.startsWith('Founder') ? 'shield' : 'user'} size={15} /></span><span><strong>{role.name}</strong><small>{role.scope}</small></span><Icon name="check-circle" size={16} className="ml-auto" style={{ color: '#15803d' }} /></div>)}</div></section>
      <section className="workspace-section"><h3 className="section-title">待接通的 access flow</h3><div className="access-list"><AccessItem icon="mail" title="Invite-only entry" detail="只允許已邀請的 Founder/Admin 或 Advisor 進入 ERP。" /><AccessItem icon="lock" title="Session boundary" detail="每個 protected route 由 Cognito session + organization scope 驗證。" /><AccessItem icon="users" title="Advisor scope" detail="Advisor 只可讀取自己的 active case assignment，除非 policy 明確授權。" /></div></section>
    </div>
  )
}

function AccessItem({ icon, title, detail }: { icon: 'mail' | 'lock' | 'users'; title: string; detail: string }) { return <div className="compact-row"><span className="work-icon blue"><Icon name={icon} size={15} /></span><div><div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</div><div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>{detail}</div></div><span className="status-pill status-warning ml-auto">pending</span></div> }
