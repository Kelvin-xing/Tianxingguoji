'use client';
import { Page, Empty, FilledData, Tag, PageHeader, RouteTabs, Confirm, FieldInput, FieldSelect, Button, Card } from '@/components/ui/standard';
import Link from 'next/link';
import { useTranslation } from 'react-i18next';
import { NewGuardianRelationshipForm } from './NewGuardianRelationshipForm';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { getWorkspaceAccessSnapshot } from '@/modules/access/client';
import { getStudent, getGuardianRelationships, searchGuardians, attachGuardianRelationship, handoffPrimaryGuardian, endGuardianRelationship, classifyGuardianRelationshipFailure, RELATIONSHIP_TYPES, type GuardianRelationshipsView, type GuardianContactHint, type RelationshipType } from '@/modules/crm/client';
const labels: Record<RelationshipType, string> = { parent: '家長', father: '父親', mother: '母親', step_parent: '繼父母', stepfather: '繼父', stepmother: '繼母', adoptive_parent: '養父母', adoptive_father: '養父', adoptive_mother: '養母', foster_parent: '寄養父母', foster_father: '寄養父', foster_mother: '寄養母', grandparent: '祖父母', paternal_grandfather: '祖父', paternal_grandmother: '祖母', maternal_grandfather: '外祖父', maternal_grandmother: '外祖母', adult_sibling: '成年兄弟姊妹', adult_brother: '成年兄弟', adult_sister: '成年姊妹', uncle: '叔伯或舅父', aunt: '姑姨', court_appointed_guardian: '法院指定監護人', institutional_guardian: '機構監護人', other_relative: '其他親屬', non_relative_guardian: '非親屬監護人', other: '其他' };
type Action = {
    kind: 'attach';
    guardianId: string;
    relationshipType: RelationshipType;
    description: string;
    legal: boolean;
    emergency: boolean;
    billing: boolean;
    consent: boolean;
} | {
    kind: 'handoff';
    guardianId: string;
    version: number;
} | {
    kind: 'end';
    relationshipId: string;
    version: number;
};
export function GuardianRelationshipPanel({ studentId }: {
    readonly studentId: string;
}) {
    const { t } = useTranslation();
    const [openPanel, setOpenPanel] = useState<'attach' | 'handoff' | null>(null);
    const [view, setView] = useState<GuardianRelationshipsView | null>(null);
    const [canManage, setCanManage] = useState(false);
    const [state, setState] = useState<'loading' | 'ready' | 'denied' | 'error'>('loading');
    const [notice, setNotice] = useState('');
    const [busy, setBusy] = useState(false);
    const locked = useRef(false);
    const attempt = useRef<{
        fingerprint: string;
        key: string;
    } | null>(null);
    const [query, setQuery] = useState('');
    const [searched, setSearched] = useState(false);
    const [candidates, setCandidates] = useState<readonly GuardianContactHint[]>([]);
    const [selected, setSelected] = useState('');
    const [relationshipType, setRelationshipType] = useState<RelationshipType>('parent');
    const [description, setDescription] = useState('');
    const [legal, setLegal] = useState(false);
    const [emergency, setEmergency] = useState(false);
    const [billing, setBilling] = useState(false);
    const [consent, setConsent] = useState(false);
    const [successor, setSuccessor] = useState('');
    const [confirmed, setConfirmed] = useState(false);
    const [endTarget, setEndTarget] = useState('');
    const refresh = useCallback(async (signal?: AbortSignal) => {
        const [next, access, student] = await Promise.all([getGuardianRelationships(studentId, signal), getWorkspaceAccessSnapshot(signal), getStudent(studentId, signal)]);
        if (signal?.aborted)
            return;
        setView(next);
        setCanManage(access.capabilities.includes('students.guardians.manage') && student.status === 'active');
        setState('ready');
        setCandidates([]);
        setSelected('');
        setSearched(false);
        setSuccessor('');
        setConfirmed(false);
        setEndTarget('');
    }, [studentId, setView, setCanManage, setState, setCandidates, setSelected, setSearched, setSuccessor, setConfirmed, setEndTarget]);
    function failure(error: unknown) {
        const kind = classifyGuardianRelationshipFailure(error);
        if (['forbidden', 'not_found', 'unauthenticated'].includes(kind)) {
            setView(null);
            setCandidates([]);
            setCanManage(false);
            setState('denied');
            return;
        }
        setNotice(kind === 'stale' ? '資料版本已更新，請重新載入後操作。' : kind === 'validation' ? '請檢查所填資料。' : kind === 'conflict' ? '目前關係狀態不允許此操作，請重新載入確認。' : '服務暫時不可用。可保留原內容重試，系統不會重複處理。');
    }
    useEffect(() => { const controller = new AbortController(); void Promise.resolve().then(() => refresh(controller.signal)).catch(error => { if (!controller.signal.aborted) {
        setState('error');
        failure(error);
    } }); return () => controller.abort(); }, [refresh]);
    async function search(event: FormEvent) {
        event.preventDefault();
        if (locked.current)
            return;
        locked.current = true;
        setBusy(true);
        setNotice('');
        setCandidates([]);
        setSelected('');
        setSearched(false);
        try {
            setCandidates(await searchGuardians(studentId, query));
            setSearched(true);
        }
        catch (error) {
            failure(error);
        }
        finally {
            locked.current = false;
            setBusy(false);
        }
    }
    async function mutate(action: Action) {
        if (locked.current || !canManage)
            return;
        locked.current = true;
        setBusy(true);
        setNotice('');
        const fingerprint = JSON.stringify(action);
        if (attempt.current?.fingerprint !== fingerprint)
            attempt.current = { fingerprint, key: `guardian-${crypto.randomUUID()}` };
        const key = attempt.current.key;
        try {
            if (action.kind === 'attach')
                await attachGuardianRelationship(studentId, { guardian_id: action.guardianId, relationship_type: action.relationshipType, relationship_description: action.relationshipType === 'other' ? action.description.trim() : null, is_legal_guardian: action.legal, is_emergency_contact: action.emergency, is_billing_contact: action.billing, notification_consent: action.consent }, key);
            else if (action.kind === 'handoff')
                await handoffPrimaryGuardian(studentId, action.guardianId, action.version, key);
            else
                await endGuardianRelationship(studentId, action.relationshipId, action.version, key);
            attempt.current = null;
            await refresh();
            setNotice(action.kind === 'attach' ? '監護人已關聯。' : action.kind === 'handoff' ? '主要聯絡人已交接，原聯絡人仍保留關聯。' : '關係已解除，歷史已保留。');
        }
        catch (error) {
            failure(error);
        }
        finally {
            locked.current = false;
            setBusy(false);
        }
    }
    async function reload() { if (locked.current)
        return; locked.current = true; setBusy(true); try {
        await refresh();
        attempt.current = null;
        setNotice('已載入最新資料。');
    }
    catch (error) {
        failure(error);
    }
    finally {
        locked.current = false;
        setBusy(false);
    } }
    if (state === 'loading')
        return <Page><Card><Empty title="正在載入監護人關係…" /></Card></Page>;
    if (state === 'denied')
        return <Page><Card><Empty title="無法存取此學生的監護人關係" action={<Link href="/students" className="ui-button ui-secondary">返回學生列表</Link>} /></Card></Page>;
    if (state === 'error' || !view)
        return <Page><Card><Empty title="監護人資料暫時無法載入。" action={<Button type="button" disabled={busy} onClick={() => void reload()}>重新載入</Button>} /></Card></Page>;
    const primary = view.relationships.find(row => row.is_primary_contact);
    return <div className="ui-page ui-standard">
    <Link href={`/students/${studentId}`} className="ui-back">← 返回學生</Link>
    <PageHeader title={view.student.display_name} description="既有歷史會保留，也不會刪除任何監護人。"/>
    <RouteTabs label={t('studentUi.sections')} items={[{ href: `/students/${studentId}`, label: t('studentUi.profile') }, { href: `/students/${studentId}/guardians`, label: t('studentUi.guardians'), current: true }]}/>
    {notice ? <p role="status" className="ui-notice">{notice}</p> : null}
    <Button type="button" variant="secondary" className="ui-fit" disabled={busy} onClick={() => void reload()}>重新載入最新資料</Button>
    <Card className="" aria-labelledby="current-relationships-heading"><h3 id="current-relationships-heading" className="ui-card-title">目前關係</h3><div className="space-y-3 mt-4">{view.relationships.map(row => <article className="ui-inset ui-stack" key={row.relationship_id}>
      <div className="ui-card-heading"><strong>{row.guardian.display_name}</strong><Tag tone={row.is_primary_contact ? 'primary' : 'neutral'}>{row.is_primary_contact ? '主要聯絡人' : '關聯監護人'}</Tag></div>
      <FilledData missingLabel={count => t('caseUi.missing', {count})} items={[{ label: '關係類型', value: labels[row.relationship_type], filled: true }, { label: '聯絡方式', value: [row.guardian.email_hint, row.guardian.phone_hint].filter(Boolean).join(' · '), filled: Boolean(row.guardian.email_hint || row.guardian.phone_hint) }]} />
      {canManage && !row.is_primary_contact ? <><Button type="button" variant="secondary" className="ui-fit" disabled={busy} onClick={() => setEndTarget(row.relationship_id)}>解除與 {row.guardian.display_name} 的關係</Button>{endTarget === row.relationship_id ? <Confirm title="確認解除此關係？" onCancel={() => setEndTarget('')} cancelDisabled={busy} confirmDisabled={busy} confirmLabel="確認解除" onConfirm={() => void mutate({ kind: 'end', relationshipId: row.relationship_id, version: row.record_version })}><p>歷史仍會保留。</p></Confirm> : null}</> : null}
    </article>)}</div></Card>
    {canManage ? <><NewGuardianRelationshipForm studentId={studentId} busy={busy} relationshipLabels={labels} onBusy={value => { locked.current = value; setBusy(value); }} onDenied={failure} onCreated={async () => { await refresh(); setNotice('新監護人已建立並關聯，主要聯絡人未變更。'); }}/>
    <Card editing={openPanel === 'attach'} className="" aria-labelledby="attach-guardian-heading"><div className="ui-card-heading"><h3 id="attach-guardian-heading" className="ui-card-title">關聯已有監護人</h3><Button type="button" variant="text" disabled={busy} onClick={() => setOpenPanel(openPanel === 'attach' ? null : 'attach')}>關聯已有監護人</Button></div><p className="ui-muted">搜尋後由你選擇；系統不會自動匹配。</p>
      {openPanel === 'attach' && <><form className="ui-stack" onSubmit={search}><label className="ui-field">搜尋姓名、電郵或電話<FieldInput value={query} onChange={event => { setQuery(event.target.value); setCandidates([]); setSelected(''); setSearched(false); }} minLength={2} maxLength={100} required disabled={busy}/></label><Button variant="secondary" className="ui-fit" disabled={busy} type="submit">搜尋監護人</Button></form>
      {searched && candidates.length === 0 ? <p role="status">未找到可關聯的監護人。</p> : null}
      <form className="ui-stack" onSubmit={event => { event.preventDefault(); void mutate({ kind: 'attach', guardianId: selected, relationshipType, description, legal, emergency, billing, consent }); }}><fieldset disabled={busy} className="grid gap-3">
        {candidates.map(candidate => <label key={candidate.id} className="flex items-start gap-3 border rounded-lg p-4 cursor-pointer"><FieldInput type="radio" name="guardian-candidate" value={candidate.id} checked={selected === candidate.id} onChange={() => setSelected(candidate.id)}/><span>{candidate.display_name}<small>{[candidate.email_hint, candidate.phone_hint].filter(Boolean).join(' · ')}</small></span></label>)}
        <label className="ui-field">關係類型<FieldSelect aria-label="關係類型" value={relationshipType} onChange={event => setRelationshipType(event.target.value as RelationshipType)}>{RELATIONSHIP_TYPES.map(type => <option key={type} value={type}>{labels[type]}</option>)}</FieldSelect></label>
        {relationshipType === 'other' ? <label className="ui-field">關係說明<FieldInput value={description} onChange={event => setDescription(event.target.value)} required maxLength={200}/></label> : null}
        <label><FieldInput type="checkbox" checked={legal} onChange={event => setLegal(event.target.checked)}/> 法定監護人</label><label><FieldInput type="checkbox" checked={emergency} onChange={event => setEmergency(event.target.checked)}/> 緊急聯絡人</label><label><FieldInput type="checkbox" checked={billing} onChange={event => setBilling(event.target.checked)}/> 帳單聯絡人</label><label><FieldInput type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)}/> 同意接收通知</label>
        <Button type="submit" variant="secondary" className="ui-fit" disabled={!selected || busy}>確認關聯</Button>
      </fieldset></form></>}</Card>
      <Card editing={openPanel === 'handoff'} className="" aria-labelledby="handoff-primary-heading"><div className="ui-card-heading"><h3 id="handoff-primary-heading" className="ui-card-title">交接主要聯絡人</h3><Button type="button" variant="text" disabled={busy} onClick={() => setOpenPanel(openPanel === 'handoff' ? null : 'handoff')}>交接主要聯絡人</Button></div><p className="ui-muted">從目前關聯的監護人中選擇；原主要聯絡人會繼續保留關聯。</p>{openPanel === 'handoff' && <><form className="ui-stack" onSubmit={event => { event.preventDefault(); if (primary && confirmed)
            void mutate({ kind: 'handoff', guardianId: successor, version: primary.record_version }); }}><fieldset disabled={busy} className="grid gap-3"><label className="ui-field">新主要聯絡人<FieldSelect aria-label="新主要聯絡人" required value={successor} onChange={event => { setSuccessor(event.target.value); setConfirmed(false); }}><option value="">請選擇</option>{view.relationships.filter(row => !row.is_primary_contact).map(row => <option key={row.guardian.id} value={row.guardian.id}>{row.guardian.display_name}</option>)}</FieldSelect></label><label><FieldInput type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)}/> 我確認交接主要聯絡人。</label><Button variant="secondary" className="ui-fit" type="submit" disabled={busy || !primary || !successor || !confirmed}>確認交接</Button></fieldset></form></>}</Card></> : <p>目前只可查看關係資料。</p>}
  </div>;
}
