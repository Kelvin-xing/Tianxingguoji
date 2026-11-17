'use client';
import { PageHeader, Tag, Table, TranslatedText, FieldInput, FieldSelect, Button, Card } from '@/components/ui/standard';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Icon } from '@/components/workspace/Icon';
import { getWorkspaceAccessSnapshot } from '@/modules/access/client';
import { REFERRAL_SOURCE_STATUSES, REFERRAL_SOURCE_TYPES, ReferralSourceIdempotencyAttempt, classifyReferralSourceFailure, createReferralSource, getReferralSource, listReferralSources, referralSourceCreateFingerprint, type ReferralSource, type ReferralSourceStatus, type ReferralSourceType, } from '@/modules/crm/client';
type LoadState = 'loading' | 'ready' | 'unauthenticated' | 'denied' | 'unavailable';
type Notice = 'success' | 'validation' | 'conflict' | 'denied' | 'unavailable' | null;
type StatusFilter = ReferralSourceStatus | 'all';
export function ReferralSourcesDirectory() {
    const mounted = useRef(false);
    const controller = useRef<AbortController | null>(null);
    const submitting = useRef(false);
    const nameInput = useRef<HTMLInputElement | null>(null);
    const attempt = useRef<ReferralSourceIdempotencyAttempt | null>(null);
    if (attempt.current === null)
        attempt.current = new ReferralSourceIdempotencyAttempt();
    const [showCreate, setShowCreate] = useState(false);
    const [state, setState] = useState<LoadState>('loading');
    const [sources, setSources] = useState<readonly ReferralSource[]>([]);
    const [canManage, setCanManage] = useState(false);
    const [filter, setFilter] = useState<StatusFilter>('all');
    const [displayName, setDisplayName] = useState('');
    const [sourceType, setSourceType] = useState<ReferralSourceType>('website');
    const [description, setDescription] = useState('');
    const [saving, setSaving] = useState(false);
    const [notice, setNotice] = useState<Notice>(null);
    const load = useCallback(async (nextFilter: StatusFilter) => {
        controller.current?.abort();
        const nextController = new AbortController();
        controller.current = nextController;
        setState('loading');
        try {
            const [nextSources, access] = await Promise.all([
                listReferralSources(nextFilter === 'all' ? undefined : nextFilter, nextController.signal),
                getWorkspaceAccessSnapshot(nextController.signal),
            ]);
            if (!mounted.current || nextController.signal.aborted)
                return;
            const canRead = access.capabilities.some((item) => String(item) === 'referral_sources.read');
            if (!canRead) {
                setSources([]);
                setCanManage(false);
                setState('denied');
                return;
            }
            setSources(nextSources.items);
            setCanManage(access.capabilities.some((item) => String(item) === 'referral_sources.manage'));
            setState('ready');
        }
        catch (error) {
            if (!mounted.current || nextController.signal.aborted)
                return;
            const failure = classifyReferralSourceFailure(error);
            setSources([]);
            setCanManage(false);
            setState(failure === 'unauthenticated' ? 'unauthenticated' : failure === 'forbidden' ? 'denied' : 'unavailable');
        }
        finally {
            if (controller.current === nextController)
                controller.current = null;
        }
    }, []);
    useEffect(() => {
        mounted.current = true;
        queueMicrotask(() => { if (mounted.current)
            void load(filter); });
        return () => {
            mounted.current = false;
            controller.current?.abort();
        };
    }, [filter, load]);
    useEffect(() => {
        if (notice === 'success')
            nameInput.current?.focus();
    }, [notice]);
    async function submitCreate(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (submitting.current || saving || !canManage)
            return;
        const draft = {
            display_name: displayName.trim(),
            source_type: sourceType,
            description: sourceType === 'other' ? description.trim() : null,
        } as const;
        if (draft.display_name.length < 1 || draft.display_name.length > 200 ||
            (sourceType === 'other' && description.trim().length === 0)) {
            setNotice('validation');
            return;
        }
        submitting.current = true;
        setSaving(true);
        setNotice(null);
        try {
            const fingerprint = referralSourceCreateFingerprint(draft);
            const receipt = await createReferralSource(draft, attempt.current!.keyFor(fingerprint));
            const authoritative = await getReferralSource(receipt.referral_source.id);
            if (authoritative.record_version !== receipt.referral_source.record_version) {
                throw new TypeError('ReferralSource authority mismatch.');
            }
            const nextSources = await listReferralSources(filter === 'all' ? undefined : filter);
            if (!mounted.current)
                return;
            attempt.current!.complete();
            setSources(nextSources.items);
            setDisplayName('');
            setSourceType('website');
            setDescription('');
            setNotice('success');
        }
        catch (error) {
            if (!mounted.current)
                return;
            const failure = classifyReferralSourceFailure(error);
            if (failure === 'forbidden' || failure === 'unauthenticated') {
                setSources([]);
                setCanManage(false);
                setDisplayName('');
                setDescription('');
                setNotice(null);
                setState(failure === 'unauthenticated' ? 'unauthenticated' : 'denied');
                return;
            }
            if (failure !== 'unavailable')
                attempt.current!.rotate();
            setNotice(failure === 'validation' ? 'validation'
                : failure === 'conflict' || failure === 'stale' ? 'conflict'
                    : 'unavailable');
        }
        finally {
            submitting.current = false;
            if (mounted.current)
                setSaving(false);
        }
    }
    return (<div className="ui-page ui-standard">
      <PageHeader title="推薦來源" description="維護經批准的客戶推薦、網站、活動及其他來源資料。" action={canManage && state === 'ready' ? <Button variant="primary" onClick={() => setShowCreate(value => !value)}>新增推薦來源</Button> : undefined}/>


      {canManage && state === 'ready' && showCreate ? (<Card className="" aria-labelledby="create-referral-source-title">
          <div className="mb-4">
            <h3 id="create-referral-source-title" className="ui-card-title">新增推薦來源</h3>
            <p className="ui-muted">名稱可以重複；來源類型建立後不能更改。</p>
          </div>
          <form onSubmit={submitCreate} className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(12rem,0.45fr)_auto] gap-3 items-end" aria-busy={saving}>
            <label className="ui-field">
              顯示名稱
              <FieldInput ref={nameInput} value={displayName} maxLength={200} required disabled={saving} autoComplete="off" onChange={(event) => { setDisplayName(event.target.value); setNotice(null); }}/>
            </label>
            <label className="ui-field">
              來源類型
              <FieldSelect value={sourceType} disabled={saving} onChange={(event) => {
                const nextType = event.target.value as ReferralSourceType;
                setSourceType(nextType);
                if (nextType !== 'other')
                    setDescription('');
                setNotice(null);
            }}>
                {REFERRAL_SOURCE_TYPES.map((type) => <option value={type} key={type}>{sourceTypeLabel(type)}</option>)}
              </FieldSelect>
            </label>
            {sourceType === 'other' ? (<label className="ui-field md:col-span-2">
                其他來源說明
                <FieldInput value={description} maxLength={500} required disabled={saving} onChange={(event) => { setDescription(event.target.value); setNotice(null); }}/>
              </label>) : null}
            <Button type="submit" variant="secondary" className="ui-fit" disabled={saving} aria-busy={saving}>
              <Icon name="plus" size={15}/>{saving ? '正在建立' : '建立來源'}
            </Button>
          </form>
          <NoticeView notice={notice}/>
        </Card>) : null}

      <Card className="" aria-busy={state === 'loading'} aria-labelledby="referral-source-list-title">
        <label className="select-field self-start md:self-auto">
          <Icon name="filter" size={15}/>
          <span className="sr-only">篩選來源狀態</span>
          <FieldSelect aria-label="篩選來源狀態" value={filter} disabled={state === 'loading'} onChange={(event) => {
            setNotice(null);
            setFilter(event.target.value as StatusFilter);
        }}>
            <option value="all">全部狀態</option>
            {REFERRAL_SOURCE_STATUSES.map((status) => (<option value={status} key={status}>{statusLabel(status)}</option>))}
          </FieldSelect>
        </label>

        <div className="mb-4">
          <h3 id="referral-source-list-title" className="ui-card-title">來源名單</h3>
          <p className="ui-muted">已停用來源仍保留供案件歷史查閱，但不能建立新的案件關聯。</p>
        </div>
        {state === 'loading' ? <State title="正在載入推薦來源" detail="請稍候。"/> : null}
        {state === 'unauthenticated' ? <State title="工作階段已失效" detail="請重新登入後再查看推薦來源。" href="/login"/> : null}
        {state === 'denied' ? <State title="無法查看推薦來源" detail="目前帳號沒有查看推薦來源的權限。"/> : null}
        {state === 'unavailable' ? <State title="推薦來源服務暫時不可用" detail="請稍後重試。" onRetry={() => void load(filter)}/> : null}
        {state === 'ready' && sources.length === 0 ? <State title="目前沒有推薦來源" detail="此篩選條件下沒有可顯示的資料。"/> : null}
        {state === 'ready' && sources.length > 0 ? (<Table headings={['顯示名稱', '狀態']}>
            {sources.map(source => <tr key={source.id}><td><Link href={`/referral-sources/${source.id}`}><strong>{source.display_name}</strong></Link><div className="ui-muted">{sourceTypeLabel(source.source_type)}</div></td><td><Tag tone={source.status === 'active' ? 'primary' : 'neutral'}>{statusLabel(source.status)}</Tag></td></tr>)}
          </Table>) : null}
        {state === 'ready' && <p className="ui-muted"><TranslatedText translationKey="studentUi.countPrefix"/> {sources.length} <TranslatedText translationKey="studentUi.countSuffix"/></p>}
      </Card>
    </div>);
}
function NoticeView({ notice }: {
    readonly notice: Notice;
}) {
    if (notice === null)
        return null;
    const message = notice === 'success' ? '推薦來源已建立，名單已重新載入。'
        : notice === 'validation' ? '請填寫 1 至 200 個字的顯示名稱；其他來源也必須填寫說明。'
            : notice === 'conflict' ? '資料已改變或本次操作有衝突，請確認後再試。'
                : notice === 'denied' ? '目前帳號不能建立推薦來源。'
                    : '結果暫時無法確認，請稍後重試；重試不會重複建立。';
    return <div className={notice === 'success' ? 'ui-notice mt-4' : 'ui-notice warning mt-4'} role={notice === 'success' ? 'status' : 'alert'}><Icon name={notice === 'success' ? 'check-circle' : 'x'} size={16}/><span>{message}</span></div>;
}
function State({ title, detail, href, onRetry }: {
    readonly title: string;
    readonly detail: string;
    readonly href?: string;
    readonly onRetry?: () => void;
}) {
    return <div className="ui-empty"><strong>{title}</strong><div className="mt-1">{detail}</div>{href ? <Link href={href} className="ui-button ui-primary mt-3">重新登入</Link> : null}{onRetry ? <Button type="button" variant="secondary" className="ui-fit mt-3" onClick={onRetry}>重新載入</Button> : null}</div>;
}
function sourceTypeLabel(type: ReferralSourceType): string {
    const labels: Readonly<Record<ReferralSourceType, string>> = {
        customer_referral: '客戶推薦', employee_referral: '員工推薦', school_referral: '學校推薦',
        partner_referral: '合作夥伴推薦', website: '網站', social_media: '社交媒體',
        paid_advertising: '付費廣告', event: '活動', walk_in: '直接查詢', other: '其他', unknown: '未知',
    };
    return labels[type];
}
function statusLabel(status: ReferralSourceStatus): string {
    return status === 'active' ? '有效' : '已停用';
}
