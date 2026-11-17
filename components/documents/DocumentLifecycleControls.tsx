"use client";
import { Button, FieldInput, FieldSelect, Notice } from "@/components/ui/standard";
import { useRef, useState } from 'react';
import { classifyDocumentFailure, getCaseDocument, getDocumentVersionHistory, mutateDocumentLifecycle, type DocumentListItem, type DocumentVersionHistory, type DocumentLifecycleAction } from '@/modules/documents/client';
import { formatDocumentDate, versionStateLabel } from './document-ui';
export function DocumentLifecycleControls({ caseId, document, onAuthoritativeChange }: {
    readonly caseId: string;
    readonly document: DocumentListItem;
    readonly onAuthoritativeChange: (document: DocumentListItem) => void;
}) {
    const [history, setHistory] = useState<DocumentVersionHistory | null>(null), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
    const [selected, setSelected] = useState(''), [confirmed, setConfirmed] = useState(false);
    const locked = useRef(false);
    const attempt = useRef<{
        action: DocumentLifecycleAction;
        version: number;
        target: string | null;
        key: string;
    } | null>(null);
    async function refresh() {
        const [next, detail] = await Promise.all([getDocumentVersionHistory(caseId, document.id), getCaseDocument(caseId, document.id)]);
        setHistory(next);
        onAuthoritativeChange(detail.document);
        setSelected('');
        setConfirmed(false);
    }
    async function load() {
        if (locked.current)
            return;
        locked.current = true;
        setBusy(true);
        setNotice('');
        try {
            await refresh();
            attempt.current = null;
        }
        catch (error) {
            setHistory(null);
            setNotice(failureMessage(error));
        }
        finally {
            locked.current = false;
            setBusy(false);
        }
    }
    async function submit(action: DocumentLifecycleAction) {
        if (locked.current || !confirmed || !history)
            return;
        const target = action === 'delete' ? null : selected;
        if (action !== 'delete' && !target)
            return;
        locked.current = true;
        setBusy(true);
        setNotice('');
        if (!attempt.current || attempt.current.action !== action || attempt.current.version !== history.record_version || attempt.current.target !== target)
            attempt.current = { action, version: history.record_version, target, key: crypto.randomUUID() };
        const command = attempt.current;
        try {
            await mutateDocumentLifecycle(caseId, document.id, command.action, command.version, command.target, command.key);
            await refresh();
            attempt.current = null;
            setNotice(action === 'delete' ? '文件已移至恢復區，30 天內可恢復安全版本。' : action === 'restore' ? '文件已恢復。' : '使用版本已更新，歷史版本仍保留。');
        }
        catch (error) {
            const failure = classifyDocumentFailure(error);
            if (['not_found', 'forbidden', 'unauthenticated'].includes(failure))
                setHistory(null);
            setNotice(failureMessage(error));
        }
        finally {
            locked.current = false;
            setBusy(false);
        }
    }
    const options = history?.versions.filter(v => v.selectable && (history.lifecycle_state === 'pending_delete' || !v.active)) ?? [];
    return <div className="ui-history ui-stack" aria-busy={busy}>
    <Button type="button" variant="weak" disabled={busy} onClick={() => void load()}>{busy ? '正在處理' : '版本與恢復管理'}</Button>
    {history ? <div className="space-y-3">
      <p className="text-sm">{history.legal_hold ? '此文件處於法律保留，不能刪除。' : history.lifecycle_state === 'pending_delete' ? `文件已停用。恢復期限：${history.restore_deadline ? formatDocumentDate(history.restore_deadline) : '不可恢復'}` : '回退只切換使用版本，不會移除歷史文件。'}</p>
      {history.versions.length === 0 ? <p className="text-sm">尚未上傳任何版本。</p> : <ul className="text-sm space-y-1">{history.versions.map((version, index) => <li key={version.id}>版本 {history.versions.length - index} · {formatDocumentDate(version.created_at)} · {versionStateLabel(version.state)}{version.active ? ' · 目前使用' : ''}{!version.selectable ? ' · 不可選用' : ''}</li>)}</ul>}
      {(history.can_restore || history.can_rollback) ? <label className="ui-field">選擇安全版本<FieldSelect aria-label="選擇安全版本" value={selected} disabled={busy} onChange={e => { setSelected(e.target.value); setConfirmed(false); attempt.current = null; }}><option value="">請選擇</option>{options.map(version => <option key={version.id} value={version.id}>版本 {history.versions.length - history.versions.findIndex(v => v.id === version.id)} · {formatDocumentDate(version.created_at)}</option>)}</FieldSelect></label> : null}
      {(history.can_delete || history.can_restore || history.can_rollback) ? <>
        <label className="flex items-start gap-2 text-sm"><FieldInput type="checkbox" checked={confirmed} disabled={busy} onChange={e => setConfirmed(e.target.checked)}/>我確認本次文件操作。</label>
        <div className="flex flex-wrap gap-2">
          {history.can_delete ? <Button type="button" variant="weak" disabled={busy || !confirmed} onClick={() => void submit('delete')}>刪除文件</Button> : null}
          {history.can_restore ? <Button type="button" variant="secondary" disabled={busy || !confirmed || !selected} onClick={() => void submit('restore')}>恢復文件</Button> : null}
          {history.can_rollback ? <Button type="button" variant="secondary" disabled={busy || !confirmed || !selected} onClick={() => void submit('rollback')}>使用所選版本</Button> : null}
        </div>
      </> : <p className="text-sm">目前沒有可執行的文件操作。</p>}
    </div> : null}
    {notice ? <Notice>{notice}</Notice> : null}
  </div>;
}
function failureMessage(error: unknown) {
    const failure = classifyDocumentFailure(error);
    if (['not_found', 'forbidden', 'unauthenticated'].includes(failure))
        return '目前無法存取此文件，請確認登入與權限。';
    if (failure === 'stale' || failure === 'conflict')
        return '文件狀態已改變或操作不適用，請重新載入版本後確認。';
    return '結果暫時無法確認，請重試原操作；重試不會重複寫入。';
}
