'use client'

import Link from 'next/link'
import { useEffect, useState, type ReactNode } from 'react'
import { getResolvedSchool, type SchoolDirectoryItem } from '@/modules/schools/client'

function value(input: unknown): string { return typeof input === 'string' && input.trim() ? input.trim() : '未知' }
function Block({ title, children }: { title: string; children: ReactNode }) {
  return <section aria-labelledby={`${title}-heading`} className="space-y-3 rounded-lg border p-4" style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}><h2 id={`${title}-heading`} className="font-semibold">{title}</h2>{children}</section>
}
function Field({ label, input }: { label: string; input: unknown }) { return <div className="min-w-0"><dt className="text-xs" style={{ color: 'var(--text-muted)' }}>{label}</dt><dd className="break-words">{value(input)}</dd></div> }

export function SchoolDetail({ schoolId }: { schoolId: string }) {
  const [school, setSchool] = useState<Omit<SchoolDirectoryItem, "source_school_key"> | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'denied'>('loading')
  useEffect(() => { const controller = new AbortController(); void getResolvedSchool(schoolId, controller.signal).then((result) => { setSchool(result); setState('ready') }).catch((error: unknown) => { if (controller.signal.aborted) return; setState(error && typeof error === 'object' && 'status' in error && ((error as { status: number }).status === 401 || (error as { status: number }).status === 403) ? 'denied' : 'error') }); return () => controller.abort() }, [schoolId])
  if (state === 'loading') return <p role="status">正在載入學校資料…</p>
  if (state === 'denied') return <p role="alert">登入狀態或學校存取權限已變更，請重新登入或聯絡管理員。</p>
  if (state === 'error' || !school) return <p role="alert">學校資料暫時無法載入。</p>
  const fields = school.fields
  return <div className="max-w-5xl space-y-4"><Link href="/schools" className="text-sm underline">返回學校目錄</Link><header><h1 className="text-xl font-semibold">{value(fields.school_name_zh) !== '未知' ? value(fields.school_name_zh) : value(fields.school_name_en)}</h1><p className="text-sm" style={{ color: 'var(--text-muted)' }}>內部編號：{school.school_id} · 未知資料保持未知</p></header>
    <Block title="基礎資料"><dl className="grid gap-3 sm:grid-cols-2"><Field label="中文名稱" input={fields.school_name_zh}/><Field label="英文名稱" input={fields.school_name_en}/><Field label="地區" input={fields.district}/><Field label="地址" input={fields.address}/><Field label="官网" input={fields.official_website || fields.website}/><Field label="電話" input={fields.phone}/></dl></Block>
    <Block title="招生資料"><dl className="grid gap-3 sm:grid-cols-2"><Field label="招生類型" input={fields.admission_type}/><Field label="適用學年" input={fields.admission_school_year || fields.school_year}/><Field label="招生年級" input={fields.admission_grade}/><Field label="申請方式" input={fields.application_method}/><Field label="申請開始日期" input={fields.application_start_date}/><Field label="截止日期" input={fields.application_deadline || fields.submission_deadline}/></dl></Block>
    <Block title="待處理更新"><p className="text-sm" style={{ color: 'var(--text-secondary)' }}>待處理更新暫時無法載入。</p></Block>
    <Block title="更新履歷"><dl className="grid gap-3 sm:grid-cols-2"><Field label="資料版本" input={school.base_snapshot_id}/><Field label="解析版本" input={school.resolved_revision_id}/><Field label="資料雜湊" input={school.resolution_sha256}/></dl></Block>
  </div>
}
