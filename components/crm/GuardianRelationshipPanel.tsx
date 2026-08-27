'use client'

import Link from 'next/link'
import { useCallback, useEffect, useState, type FormEvent } from 'react'

import { attachGuardian, handoffPrimaryGuardian, listGuardians, type GuardianSummaryDto } from '@/components/crm/f2-contract'
import { DeniedState, EmptyState, ErrorState, LoadingState, StaleState, UnavailableState } from '@/components/states/WorkspaceState'
import { ApiClientError } from '@/lib/api/client'

export function GuardianRelationshipPanel({ studentId }: { readonly studentId: string }) {
  const [guardians, setGuardians] = useState<readonly GuardianSummaryDto[]>([])
  const [state, setState] = useState<'loading' | 'ready' | 'empty' | 'denied' | 'unavailable' | 'error' | 'stale'>('loading')
  const [guardianId, setGuardianId] = useState('')
  const [relationshipType, setRelationshipType] = useState('parent')
  const [expectedVersion, setExpectedVersion] = useState(1)
  const [notice, setNotice] = useState<string | null>(null)
  const load = useCallback(() => { setState('loading'); void listGuardians(studentId).then((items) => { setGuardians(items); setState(items.length ? 'ready' : 'empty') }).catch((error: unknown) => { if (error instanceof ApiClientError && error.code === 'FORBIDDEN') setState('denied'); else if (error instanceof ApiClientError && error.code === 'SERVICE_UNAVAILABLE') setState('unavailable'); else setState('error') }) }, [studentId])
  useEffect(() => { load() }, [load])

  async function attach(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setNotice(null); try { await attachGuardian(studentId, { mode: 'existing', guardian_id: guardianId, relationship_type: relationshipType, flags: ['primary'] }, crypto.randomUUID()); setNotice('关系命令已返回 receipt。'); load() } catch (error: unknown) { setNotice(error instanceof ApiClientError && error.code === 'STALE_VERSION' ? '关系版本已变化，请重新载入后再提交。' : '关系服务暂时不可用；草稿已保留。') } }
  async function handoff(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setNotice(null); try { await handoffPrimaryGuardian(studentId, { successor_guardian_id: guardianId }, crypto.randomUUID(), expectedVersion); setNotice('Primary handoff 命令已返回 receipt。'); load() } catch (error: unknown) { setNotice(error instanceof ApiClientError && error.code === 'STALE_VERSION' ? 'Primary 已被其他操作更新，请重新载入最新版本。' : 'Primary handoff 暂时不可用。') } }

  if (state === 'loading') return <LoadingState title="正在载入 Guardian relationships" detail="Current 与 history 使用独立服务端 DTO。" />
  if (state === 'denied') return <DeniedState title="无法访问 Guardian relationships" detail="当前身份没有该 Student 的关系维护权限。" action={<Link className="primary-button" href={`/students/${studentId}`}>返回 Student</Link>} />
  if (state === 'unavailable') return <UnavailableState title="Guardian 服务暂时不可用" detail="不会使用旧关系枚举或 preview adapter。" onRetry={load} />
  if (state === 'error') return <ErrorState title="Guardian 读取失败" detail="请保留当前 Student 后重试。" onRetry={load} />
  return <div className="max-w-5xl mx-auto space-y-6"><div><Link href={`/students/${studentId}`} className="quiet-link">← 返回 Student</Link><h2 className="page-title mt-3">Guardian 与 relationship</h2><p className="page-subtitle">关系类型、说明与 flags 都由冻结 DTO 校验；不会自动关联、合并或替换 Primary。</p></div>{state === 'empty' ? <EmptyState title="当前没有 Guardian relationship" detail="服务端数据不变量需要新增或交接关系；请使用明确命令。" /> : <section className="workspace-section"><h3 className="section-title">Current relationships</h3><div className="space-y-2 mt-4">{guardians.map((guardian) => <div className="selection-card selected" key={guardian.id}><span className="min-w-0"><strong>{guardian.display_name}</strong><small>{guardian.relationship_type} · {guardian.email ?? guardian.phone ?? '未提供联络'}</small><small>{guardian.flags.join(' · ') || '普通关系'}</small></span><span className="status-pill status-success">v{guardian.record_version}</span></div>)}</div></section>}<section className="workspace-section"><h3 className="section-title">受控关系命令</h3><form className="grid gap-3 mt-4" onSubmit={attach}><label className="field-label"><span>已有 Guardian ID</span><input value={guardianId} onChange={(event) => setGuardianId(event.target.value)} required /></label><label className="field-label"><span>Relationship type</span><input value={relationshipType} onChange={(event) => setRelationshipType(event.target.value)} required /></label><button className="primary-button justify-center" type="submit">新增 relationship</button></form><form className="grid gap-3 mt-5" onSubmit={handoff}><label className="field-label"><span>Expected current relationship version</span><input type="number" min="1" value={expectedVersion} onChange={(event) => setExpectedVersion(Number(event.target.value))} required /></label><button className="secondary-button justify-center" type="submit">Primary handoff</button></form>{notice ? <p className="inline-callout mt-4" role="status">{notice}</p> : null}</section>{state === 'stale' ? <StaleState title="关系版本已变化" detail="请重新载入后继续。" onRetry={load} /> : null}</div>
}
