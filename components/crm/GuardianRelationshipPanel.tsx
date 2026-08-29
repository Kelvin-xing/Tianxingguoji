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

  async function attach(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setNotice(null); try { await attachGuardian(studentId, { mode: 'existing', guardian_id: guardianId, relationship_type: relationshipType, flags: ['primary'] }, crypto.randomUUID()); setNotice('關係已更新。'); load() } catch (error: unknown) { setNotice(error instanceof ApiClientError && error.code === 'STALE_VERSION' ? '關係版本已更新，請重新載入後再提交。' : '關係服務暫時不可用，草稿已保留。') } }
  async function handoff(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setNotice(null); try { await handoffPrimaryGuardian(studentId, { successor_guardian_id: guardianId }, crypto.randomUUID(), expectedVersion); setNotice('主要聯絡人已更新。'); load() } catch (error: unknown) { setNotice(error instanceof ApiClientError && error.code === 'STALE_VERSION' ? '主要聯絡人資料已更新，請重新載入最新版本。' : '主要聯絡人暫時無法更新。') } }

  if (state === 'loading') return <LoadingState title="正在載入監護人關係" detail="請稍候。" />
  if (state === 'denied') return <DeniedState title="無法查看監護人關係" detail="目前帳號沒有維護此學生關係的權限。" action={<Link className="primary-button" href={`/students/${studentId}`}>返回學生</Link>} />
  if (state === 'unavailable') return <UnavailableState title="監護人服務暫時不可用" detail="請稍後重試。" onRetry={load} />
  if (state === 'error') return <ErrorState title="監護人資料讀取失敗" detail="請保留目前學生資料後重試。" onRetry={load} />
  return <div className="max-w-5xl mx-auto space-y-6"><div><Link href={`/students/${studentId}`} className="quiet-link">← 返回學生</Link><h2 className="page-title mt-3">監護人關係</h2><p className="page-subtitle">管理學生目前關聯的監護人與主要聯絡人。</p></div>{state === 'empty' ? <EmptyState title="目前沒有監護人關係" detail="請新增或交接一項關係。" /> : <section className="workspace-section"><h3 className="section-title">目前關係</h3><div className="space-y-2 mt-4">{guardians.map((guardian) => <div className="selection-card selected" key={guardian.id}><span className="min-w-0"><strong>{guardian.display_name}</strong><small>{relationshipLabel(guardian.relationship_type)} · {guardian.email ?? guardian.phone ?? '未提供聯絡方式'}</small><small>{guardian.flags.map(flagLabel).join(' · ') || '一般關係'}</small></span><span className="status-pill status-success">v{guardian.record_version}</span></div>)}</div></section>}<section className="workspace-section"><h3 className="section-title">新增關係</h3><form className="grid gap-3 mt-4" onSubmit={attach}><label className="field-label"><span>現有監護人編號</span><input value={guardianId} onChange={(event) => setGuardianId(event.target.value)} required /></label><label className="field-label"><span>關係類型</span><input value={relationshipType} onChange={(event) => setRelationshipType(event.target.value)} required /></label><button className="primary-button justify-center" type="submit">新增關係</button></form><form className="grid gap-3 mt-5" onSubmit={handoff}><label className="field-label"><span>目前關係版本</span><input type="number" min="1" value={expectedVersion} onChange={(event) => setExpectedVersion(Number(event.target.value))} required /></label><button className="secondary-button justify-center" type="submit">交接主要聯絡人</button></form>{notice ? <p className="inline-callout mt-4" role="status">{notice}</p> : null}</section>{state === 'stale' ? <StaleState title="關係版本已更新" detail="請重新載入後繼續。" onRetry={load} /> : null}</div>
}

function relationshipLabel(value: string): string {
  const labels: Readonly<Record<string, string>> = { parent: '家長', father: '父親', mother: '母親', step_parent: '繼父母', stepfather: '繼父', stepmother: '繼母', adoptive_parent: '養父母', adoptive_father: '養父', adoptive_mother: '養母', foster_parent: '寄養父母', foster_father: '寄養父', foster_mother: '寄養母', grandparent: '祖父母', paternal_grandfather: '祖父', paternal_grandmother: '祖母', maternal_grandfather: '外祖父', maternal_grandmother: '外祖母', adult_sibling: '成年兄弟姊妹', adult_brother: '成年兄弟', adult_sister: '成年姊妹', uncle: '叔伯或舅父', aunt: '姑姨', court_appointed_guardian: '法院指定監護人', institutional_guardian: '機構監護人', other_relative: '其他親屬', non_relative_guardian: '非親屬監護人', other: '其他' };
  return labels[value] ?? '監護人';
}

function flagLabel(value: string): string {
  const labels: Readonly<Record<string, string>> = { primary: '主要聯絡人', emergency: '緊急聯絡人', billing: '帳務聯絡人', notification: '接收通知' };
  return labels[value] ?? '一般關係';
}
