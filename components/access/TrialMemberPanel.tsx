'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiClientError, expectArray, expectRecord, expectString, requestApi } from '@/lib/api/client'
import { isK12BusinessCategory, isTrialLevel, type K12BusinessCategory, type TrialLevel } from '@/modules/access/public'

type Member = Readonly<{ userId: string; name: string; email: string; level: TrialLevel | null; categories: readonly K12BusinessCategory[]; status: 'active' | 'disabled' | null; version: number | null }>
type Directory = Readonly<{ currentUserId: string; bootstrapRequired: boolean; members: readonly Member[] }>
const levelNames: Record<TrialLevel, string> = { founder: '創始人', l1: 'L1 · 全部業務', l2: 'L2 · 分類業務', l3: 'L3 · 指派任務' }
const categoryNames: Record<K12BusinessCategory, string> = { international_school: '國際學校', local_school: '本地學校' }

export function TrialMemberPanel() {
  const [directory, setDirectory] = useState<Directory | null>(null)
  const [selected, setSelected] = useState<Member | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [denied, setDenied] = useState(false)
  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true); setMessage(null)
    try {
      setDirectory(await requestApi({ path: '/api/v1/auth/users/trial-access', signal }, decodeDirectory))
      setDenied(false)
    } catch (error) {
      if (signal?.aborted) return
      setDenied(error instanceof ApiClientError && error.code === 'FORBIDDEN')
      setMessage(errorMessage(error))
    } finally { if (!signal?.aborted) setLoading(false) }
  }, [])
  useEffect(() => { const controller = new AbortController(); queueMicrotask(() => { if (!controller.signal.aborted) void load(controller.signal) }); return () => controller.abort() }, [load])

  return <div className="max-w-[1200px] mx-auto space-y-6">
    <header><div className="eyebrow">管理 · 員工權限</div><h2 className="page-title">員工等級與業務範圍</h2>
      <p className="page-subtitle">只有創始人可以設定等級。L2 按業務分類工作，L3 只處理被指派的任務。</p></header>
    {message && <div role="alert" className="form-error">{message}</div>}
    {loading && <p role="status">正在載入員工資料…</p>}
    {!loading && !denied && !directory && <button className="secondary-button" onClick={() => void load()}>重新載入</button>}
    {!loading && !denied && directory && <>
      {directory.bootstrapRequired && <section className="workspace-section">
        <h3 className="section-title">開始使用員工等級</h3><p className="mt-2 text-sm">先啟用你的創始人等級，再逐一設定同事的等級與範圍。其他員工不會自動獲得新權限。</p>
        <button className="primary-button mt-4" onClick={() => setSelected(directory.members.find((m) => m.userId === directory.currentUserId) ?? null)}>設定我的創始人等級</button>
      </section>}
      <section className="workspace-section">
        <div className="flex flex-wrap justify-between gap-3 mb-4"><h3 className="section-title">員工列表</h3><button className="secondary-button" onClick={() => void load()}>重新載入</button></div>
        {directory.members.length === 0 && <p>目前沒有可管理的員工。</p>}
        <div className="grid gap-3 md:grid-cols-2">{directory.members.map((member) => <article key={member.userId} className="rounded-xl border p-4 min-w-0" style={{ borderColor: 'var(--border)' }}>
          <div className="flex flex-wrap justify-between gap-2"><h4 className="font-semibold break-words">{member.name}</h4><span>{member.status === 'disabled' ? '已停用' : member.level ? levelNames[member.level] : '尚未設定等級'}</span></div>
          <p className="text-sm break-all mt-1">{member.email}</p>
          <p className="text-sm mt-2">{member.level === 'l2' ? member.categories.map((c) => categoryNames[c]).join('、') || '尚未授權業務分類' : member.level === 'l3' ? '權限由任務指派決定' : member.level ? '全部業務範圍' : '待創始人設定'}</p>
          <button className="secondary-button mt-3" disabled={directory.bootstrapRequired && member.userId !== directory.currentUserId}
            onClick={() => setSelected(member)}>設定 {member.name} 的權限</button>
        </article>)}</div>
      </section>
      {selected && <LevelEditor key={selected.userId} member={selected} bootstrap={directory.bootstrapRequired}
        onCancel={() => setSelected(null)} onSaved={() => { setSelected(null); void load() }} />}
    </>}
  </div>
}

function LevelEditor({ member, bootstrap, onCancel, onSaved }: { member: Member; bootstrap: boolean; onCancel: () => void; onSaved: () => void }) {
  const [level, setLevel] = useState<TrialLevel>(bootstrap ? 'founder' : member.level ?? 'l3')
  const [categories, setCategories] = useState<readonly K12BusinessCategory[]>(member.categories)
  const [enabled, setEnabled] = useState(member.status !== 'disabled')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const attempt = useRef<{ signature: string; key: string } | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => { heading.current?.focus() }, [])
  async function save() {
    if (saving) return
    const body = { level, categories: level === 'l2' ? [...categories].sort() : [], status: enabled ? 'active' : 'disabled', expected_record_version: member.version }
    const signature = JSON.stringify(body)
    if (attempt.current?.signature !== signature) attempt.current = { signature, key: `trial-member-${crypto.randomUUID()}` }
    setSaving(true); setMessage(null)
    try {
      await requestApi({ path: `/api/v1/auth/users/${member.userId}/trial-access`, method: 'PATCH', body, idempotencyKey: attempt.current.key }, (value) => {
        const receipt = expectRecord(value); expectString(receipt.receipt_id); return receipt
      })
      onSaved()
    } catch (error) { setMessage(errorMessage(error)) } finally { setSaving(false) }
  }
  return <section className="workspace-section" aria-labelledby="level-editor-title">
    <h3 id="level-editor-title" tabIndex={-1} ref={heading} className="section-title">設定 {member.name} 的權限</h3>
    <label className="block mt-4">員工等級<select className="block w-full mt-2" value={level} disabled={saving || bootstrap} onChange={(e) => { setLevel(e.target.value as TrialLevel); setMessage(null) }}>
      {Object.entries(levelNames).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label>
    {level === 'l2' && <fieldset className="mt-4"><legend>可負責的 K12 業務分類</legend><div className="flex flex-wrap gap-4 mt-2">{Object.entries(categoryNames).map(([key, name]) => <label key={key} className="flex items-center gap-2"><input type="checkbox" checked={categories.includes(key as K12BusinessCategory)} disabled={saving}
      onChange={(e) => setCategories(e.target.checked ? [...categories, key as K12BusinessCategory] : categories.filter((c) => c !== key))} />{name}</label>)}</div>
      {categories.length === 0 && <p className="text-sm mt-2">未選分類時，不能查看或操作任何分類案件。</p>}</fieldset>}
    {!bootstrap && <label className="flex items-center gap-2 mt-4"><input type="checkbox" checked={enabled} disabled={saving || member.status === "disabled"} onChange={(e) => setEnabled(e.target.checked)} />啟用此員工帳號</label>}
    {message && <p role="alert" className="form-error mt-4">{message}</p>}
    <div className="flex flex-wrap justify-end gap-2 mt-5"><button className="secondary-button" disabled={saving} onClick={onCancel}>取消</button><button className="primary-button" disabled={saving} onClick={() => void save()}>{saving ? '正在儲存…' : '儲存權限'}</button></div>
  </section>
}
function errorMessage(error: unknown): string {
  if (!(error instanceof ApiClientError)) return '暫時無法完成操作，請稍後重試。'
  if (error.code === 'FORBIDDEN') return '只有目前有效的創始人帳號可以管理員工等級。'
  if (error.code === 'STALE_VERSION') return '權限已被其他人修改，請重新載入後再設定。'
  if (error.code === 'CONFLICT') return '無法儲存：請保留至少一位有效創始人，並重新載入確認目前設定。'
  if (error.code === 'VALIDATION_FAILED') return '請檢查員工等級和業務分類。'
  return '權限服務暫時不可用，請稍後重試。'
}
function decodeDirectory(value: unknown): Directory {
  const root = expectRecord(value)
  if (typeof root.bootstrap_required !== 'boolean') throw new TypeError('Invalid member directory')
  return { currentUserId: expectString(root.current_user_id), bootstrapRequired: root.bootstrap_required,
    members: expectArray(root.members, (value): Member => {
      const row = expectRecord(value)
      if (row.level !== null && !isTrialLevel(row.level)) throw new TypeError('Invalid member level')
      if (row.status !== null && row.status !== 'active' && row.status !== 'disabled') throw new TypeError('Invalid member status')
      if (row.record_version !== null && (!Number.isSafeInteger(row.record_version) || Number(row.record_version) < 1)) throw new TypeError('Invalid member version')
      return { userId: expectString(row.user_id), name: expectString(row.display_name), email: expectString(row.email), level: row.level,
        status: row.status, version: row.record_version as number | null, categories: expectArray(row.categories, (category) => {
          if (!isK12BusinessCategory(category)) throw new TypeError('Invalid member category'); return category
        }) }
    }) }
}
