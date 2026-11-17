'use client';
import { Confirm, FieldInput, Button } from '@/components/ui/standard';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Icon } from '@/components/workspace/Icon';
import { ApiClientError } from '@/lib/api/client';
import { PendingDeletionIdempotencyAttempt, classifyPendingDeletionFailure, pendingDeletionFingerprint, requestPendingDeletion, type DeletionEntityType, type StudentStatus, } from '@/modules/crm/client';
type CommandState = 'idle' | 'confirming' | 'submitting' | 'validation' | 'stale' | 'conflict' | 'denied' | 'unauthenticated' | 'unavailable';
export function PendingDeletionRequestControl({ entityType, entityId, status, recordVersion, onRequested, onReload, }: {
    readonly entityType: DeletionEntityType;
    readonly entityId: string;
    readonly status: StudentStatus;
    readonly recordVersion: number;
    readonly onRequested: () => void | Promise<void>;
    readonly onReload: () => void;
}) {
    const form = useRef<HTMLFormElement>(null);
    const attempt = useRef(new PendingDeletionIdempotencyAttempt());
    const submissionLock = useRef(false);
    const trigger = useRef<HTMLButtonElement>(null);
    const confirmation = useRef<HTMLInputElement>(null);
    const [commandState, setCommandState] = useState<CommandState>('idle');
    const [confirmed, setConfirmed] = useState(false);
    const [requestId, setRequestId] = useState<string | null>(null);
    useEffect(() => {
        if (commandState === 'confirming')
            confirmation.current?.focus();
    }, [commandState]);
    if (status === 'pending_delete') {
        return <div className="ui-notice" role="status"><Icon name="lock" size={15}/><span>這筆資料已進入待刪除審查，現有資料仍會保留，但相關修改已受限制。</span></div>;
    }
    function begin() {
        setConfirmed(false);
        setRequestId(null);
        setCommandState('confirming');
    }
    function cancel() {
        setConfirmed(false);
        setRequestId(null);
        setCommandState('idle');
        queueMicrotask(() => trigger.current?.focus());
    }
    async function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (submissionLock.current)
            return;
        if (!confirmed) {
            setCommandState('validation');
            return;
        }
        submissionLock.current = true;
        setCommandState('submitting');
        setRequestId(null);
        try {
            const fingerprint = pendingDeletionFingerprint(entityType, entityId, recordVersion);
            await requestPendingDeletion(entityType, entityId, recordVersion, attempt.current.keyFor(fingerprint));
            attempt.current.complete();
            await onRequested();
        }
        catch (error) {
            const failure = classifyPendingDeletionFailure(error);
            setRequestId(error instanceof ApiClientError ? error.requestId : null);
            setCommandState(failure === 'not_found' || failure === 'forbidden' ? 'denied' : failure);
        }
        finally {
            submissionLock.current = false;
        }
    }
    if (commandState === 'idle') {
        return <Button ref={trigger} type="button" variant="text" className="ui-fit" onClick={begin}><Icon name="lock" size={15}/>申請待刪除審查</Button>;
    }
    const pending = commandState === 'submitting';
    return (<Confirm title="確認申請待刪除審查" onCancel={cancel} cancelDisabled={pending} onConfirm={() => form.current?.requestSubmit()} confirmDisabled={pending} confirmLabel={pending ? '提交中…' : '確認送交審查'}>
    <form ref={form} className="w-full basis-full mt-4 border-t pt-4 space-y-4" style={{ borderColor: 'var(--border-subtle)' }} onSubmit={submit}>
      <div>

        <p className="ui-muted">提交後會限制相關修改，但不會刪除這筆資料或既有歷史。</p>
      </div>
      <label className="flex items-start gap-3 text-sm" style={{ color: 'var(--text-secondary)' }}>
        <FieldInput ref={confirmation} type="checkbox" checked={confirmed} onChange={(event) => { setConfirmed(event.target.checked); setCommandState('confirming'); }} disabled={pending} className="mt-1"/>
        <span>我已確認要將這筆資料送交待刪除審查，並理解資料目前不會被刪除。</span>
      </label>
      <CommandFeedback state={commandState} requestId={requestId} onReload={onReload}/>
    </form>
    </Confirm>);
}
function CommandFeedback({ state, requestId, onReload }: {
    readonly state: CommandState;
    readonly requestId: string | null;
    readonly onReload: () => void;
}) {
    if (state === 'idle' || state === 'confirming' || state === 'submitting')
        return null;
    const message = state === 'validation'
        ? '請先勾選確認選項。'
        : state === 'stale'
            ? '資料已被其他操作更新，請重新載入最新版本後再確認。'
            : state === 'conflict'
                ? '這筆資料可能已進入待刪除審查，或目前狀態與本次申請衝突。請重新載入確認。'
                : state === 'unauthenticated'
                    ? '工作階段已失效，請重新登入。'
                    : state === 'denied'
                        ? '你的帳號目前無法提交這筆資料的待刪除申請。'
                        : '申請結果暫時無法確認，請稍後重試；相同申請不會重複建立。';
    return <div className="ui-notice warning" role="alert"><Icon name="x" size={15}/><span>{message}{requestId ? <small className="block mt-1">參考編號：{requestId}</small> : null}{state === 'stale' || state === 'conflict' ? <Button type="button" variant="secondary" className="ui-fit mt-3" onClick={onReload}>重新載入最新資料</Button> : null}</span></div>;
}
