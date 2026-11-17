'use client';
import Link from 'next/link';
import { useTranslation } from 'react-i18next';
import { Page, PageHeader, Card, Button, Tag, FilledData, Empty, RouteTabs, SystemData, DataList } from '@/components/ui/standard';
import { useEffect, useRef, useState } from 'react';
import { PendingDeletionRequestControl } from '@/components/crm/PendingDeletionRequestControl';
import { GuardianProfileEditor, StudentProfileEditor } from '@/components/crm/ProfileEditPanel';
import { Icon } from '@/components/workspace/Icon';
import { getWorkspaceAccessSnapshot } from '@/modules/access/client';
import { classifyStudentRequestFailure, getGuardianRelationships, getStudent, type CurrentGuardianRelationship, type StudentDetail, type StudentGuardianItem, } from '@/modules/crm/client';
type EditTarget = {
    readonly kind: 'student';
} | {
    readonly kind: 'guardian';
    readonly guardianId: string;
};
type DetailState = {
    readonly kind: 'loading';
} | {
    readonly kind: 'ready';
    readonly student: StudentDetail;
    readonly relationships: readonly CurrentGuardianRelationship[];
    readonly canManageGuardians: boolean;
    readonly canManageProfiles: boolean;
    readonly canRequestDeletion: boolean;
    readonly canCreateCases: boolean;
} | {
    readonly kind: 'unauthenticated' | 'forbidden' | 'not_found' | 'error';
};
export function StudentDetailView({ studentId }: {
    readonly studentId: string;
}) {
    const { t } = useTranslation();
    const [state, setState] = useState<DetailState>({ kind: 'loading' });
    const [reloadToken, setReloadToken] = useState(0);
    const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
    const [successMessage, setSuccessMessage] = useState<string | null>(null);
    const lastEditTrigger = useRef<HTMLButtonElement | null>(null);
    const successNotice = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        const controller = new AbortController();
        Promise.all([
            getStudent(studentId, controller.signal),
            getGuardianRelationships(studentId, controller.signal),
            getWorkspaceAccessSnapshot(controller.signal).catch(() => null),
        ])
            .then(([student, guardianView, access]) => {
            const guardianIds = new Set(student.guardians.map(({ id }) => id));
            if (guardianView.relationships.some(({ guardian }) => !guardianIds.has(guardian.id))) {
                throw new TypeError('Guardian profile data does not match the current relationship view.');
            }
            setState({
                kind: 'ready',
                student,
                relationships: guardianView.relationships,
                canManageGuardians: access?.capabilities.includes('students.guardians.manage') ?? false,
                canManageProfiles: access?.capabilities.includes('students.profiles.manage') ?? false,
                canRequestDeletion: hasCapability(access?.capabilities ?? [], 'students.deletion.request'),
                canCreateCases: hasCapability(access?.capabilities ?? [], 'cases.create'),
            });
        })
            .catch((error: unknown) => {
            if (controller.signal.aborted)
                return;
            const failure = classifyStudentRequestFailure(error);
            if (failure === 'unauthenticated' || failure === 'forbidden' || failure === 'not_found') {
                setState({ kind: failure });
                return;
            }
            setState({ kind: 'error' });
        });
        return () => controller.abort();
    }, [reloadToken, studentId]);
    useEffect(() => {
        if (successMessage !== null && state.kind === 'ready')
            successNotice.current?.focus();
    }, [state, successMessage]);
    function reloadAuthoritative() {
        setEditTarget(null);
        setState({ kind: 'loading' });
        setReloadToken((value) => value + 1);
    }
    function saved(message: string) {
        setSuccessMessage(message);
        reloadAuthoritative();
    }
    function beginEdit(target: EditTarget, trigger: HTMLButtonElement) {
        lastEditTrigger.current = trigger;
        setSuccessMessage(null);
        setEditTarget(target);
    }
    function cancelEdit() {
        setEditTarget(null);
        queueMicrotask(() => lastEditTrigger.current?.focus());
    }
    if (state.kind === 'loading')
        return <DetailMessage icon="clock" title="正在載入學生資料" detail="請稍候。"/>;
    if (state.kind === 'unauthenticated')
        return <DetailMessage icon="lock" title="工作階段已失效" detail="請重新登入後再查看學生資料。" href="/login" action="重新登入"/>;
    if (state.kind === 'forbidden')
        return <DetailMessage icon="shield" title="無法查看學生資料" detail="你的帳號目前沒有查看此學生的權限。" href="/students" action="返回學生名單"/>;
    if (state.kind === 'not_found')
        return <DetailMessage icon="users" title="找不到學生資料" detail="這筆學生資料不存在或已無法查看。" href="/students" action="返回學生名單"/>;
    if (state.kind === 'error')
        return <DetailMessage icon="x" title="學生服務暫時不可用" detail="請稍後重試。" onRetry={() => { setState({ kind: 'loading' }); setReloadToken((value) => value + 1); }}/>;
    if (state.kind !== 'ready')
        return null;
    const { student, relationships, canManageGuardians, canManageProfiles, canRequestDeletion, canCreateCases } = state;
    const active = student.status === 'active';
    const relationshipsByGuardianId = new Map(relationships.map((relationship) => [relationship.guardian.id, relationship] as const));
    return (<Page>
      <Link href="/students" className="ui-back">學生與監護人</Link>
      <PageHeader title={student.displayName} action={active && canCreateCases ? <Link href={`/cases/new?student=${student.id}`} className="ui-button ui-primary"><Icon name="plus" size={15}/>建立案件</Link> : undefined}>
        <Tag tone={active ? 'primary' : 'warning'}>{active ? '有效' : '待刪除審查'}</Tag>
      </PageHeader>
      {active && canManageGuardians && <RouteTabs label={t('studentUi.sections')} items={[{ href: `/students/${student.id}`, label: t('studentUi.profile'), current: true }, { href: `/students/${student.id}/guardians`, label: t('studentUi.guardians') }]}/>}

      {!active ? <div className="ui-notice" role="status"><Icon name="lock" size={15}/><span>這筆學生資料正在進行待刪除審查。資料與歷史仍會保留，但建立案件、編輯資料和管理監護人關係已受限制。</span></div> : null}

      <Card title="學生基本資料" editing={active && editTarget?.kind === 'student'} action={<div className="ui-actions">
        {active && canRequestDeletion && <PendingDeletionRequestControl entityType="student" entityId={student.id} status={student.status} recordVersion={student.recordVersion} onRequested={() => saved('學生已送交待刪除審查。')} onReload={reloadAuthoritative}/>}
        {active && canManageProfiles && <Button type="button" variant="text" onClick={event => beginEdit({ kind: 'student' }, event.currentTarget)} disabled={editTarget?.kind === 'student'}>編輯學生資料</Button>}
      </div>}>
        {active && editTarget?.kind === 'student'
            ? <StudentProfileEditor student={student} onCancel={cancelEdit} onSaved={() => saved('學生資料已儲存。')} onReload={reloadAuthoritative}/>
            : <FilledData missingLabel={count => t('caseUi.missing', { count })} items={[
                    { label: '出生日期', value: student.dateOfBirth, filled: Boolean(student.dateOfBirth) },
                    { label: '聯絡電郵', value: student.contactEmail, filled: Boolean(student.contactEmail) },
                    { label: '聯絡電話', value: student.contactPhone, filled: Boolean(student.contactPhone) },
                    { label: '更新時間', value: formatDate(student.updatedAt), filled: true },
                ]}/>}
      </Card>

      {successMessage ? <div ref={successNotice} className="ui-notice" role="status" tabIndex={-1}><Icon name="check-circle" size={15}/><span>{successMessage}</span></div> : null}

      <Card aria-labelledby="student-guardian-heading">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 mb-4">
          <div><h3 id="student-guardian-heading" className="ui-card-title">監護人與聯絡關係</h3><p className="ui-muted">顯示目前關聯的監護人及其資料狀態；聯絡資料只顯示脫敏提示。</p></div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs shrink-0" style={{ color: 'var(--text-muted)' }}>{student.guardians.length} 筆</span>
            {active && canManageGuardians ? <Link href={`/students/${student.id}/guardians`} className="ui-button ui-text"><Icon name="settings" size={15}/>管理監護人關係</Link> : null}
          </div>
        </div>
        {student.guardians.length === 0
            ? <div className="ui-empty">目前沒有有效監護人關係。</div>
            : <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">{student.guardians.map((guardian) => <GuardianSummary key={guardian.id} relationship={relationshipsByGuardianId.get(guardian.id)} guardian={guardian} studentActive={active} canManageProfiles={canManageProfiles} canRequestDeletion={canRequestDeletion} editing={editTarget?.kind === 'guardian' && editTarget.guardianId === guardian.id} onEdit={(trigger) => beginEdit({ kind: 'guardian', guardianId: guardian.id }, trigger)} onCancel={cancelEdit} onSaved={() => saved('監護人資料已儲存。')} onDeletionRequested={() => saved('監護人已送交待刪除審查。')} onReload={reloadAuthoritative}/>)}</div>}
      </Card>
      <SystemData><DataList items={[{ label: t('studentUi.studentId'), value: student.id }, { label: t('studentUi.version'), value: student.recordVersion }]}/>
        {student.guardians.map(guardian => <DataList key={guardian.id} items={[{ label: guardian.displayName, value: guardian.id }, { label: t('studentUi.version'), value: guardian.recordVersion }]}/>)}
      </SystemData>
    </Page>);
}
function DetailMessage({ title, detail, href, action, onRetry }: {
    readonly icon: 'clock' | 'lock' | 'shield' | 'users' | 'x';
    readonly title: string;
    readonly detail: string;
    readonly href?: string;
    readonly action?: string;
    readonly onRetry?: () => void;
}) {
    return <Page><Card><Empty title={title} detail={detail} action={<>{href && action ? <Link href={href} className="ui-button ui-secondary">{action}</Link> : null}{onRetry ? <Button onClick={onRetry}>重新載入</Button> : null}</>}/></Card></Page>;
}
function GuardianSummary({ relationship, guardian, studentActive, canManageProfiles, canRequestDeletion, editing, onEdit, onCancel, onSaved, onDeletionRequested, onReload }: {
    readonly relationship?: CurrentGuardianRelationship;
    readonly guardian: StudentGuardianItem;
    readonly studentActive: boolean;
    readonly canManageProfiles: boolean;
    readonly canRequestDeletion: boolean;
    readonly editing: boolean;
    readonly onEdit: (trigger: HTMLButtonElement) => void;
    readonly onCancel: () => void;
    readonly onSaved: () => void;
    readonly onDeletionRequested: () => void;
    readonly onReload: () => void;
}) {
    const { t } = useTranslation();
    const flags = [
        guardian.isLegalGuardian && '法定監護',
        guardian.isEmergencyContact && '緊急聯絡',
        guardian.isBillingContact && '帳務聯絡',
        guardian.notificationConsent && '接收通知',
    ].filter(Boolean);
    const contact = [relationship?.guardian.email_hint, relationship?.guardian.phone_hint]
        .filter(Boolean)
        .join(' · ');
    const active = guardian.status === 'active';
    return <Card className="ui-inset" title={guardian.displayName} editing={editing} action={<div className="ui-actions">
    {studentActive && active && canRequestDeletion && <PendingDeletionRequestControl entityType="guardian" entityId={guardian.id} status={guardian.status} recordVersion={guardian.recordVersion} onRequested={onDeletionRequested} onReload={onReload}/>}
    {studentActive && active && canManageProfiles && <Button type="button" variant="text" onClick={event => onEdit(event.currentTarget)} disabled={editing}>編輯監護人資料</Button>}
  </div>}>
    <Tag tone={!active ? 'warning' : guardian.isPrimaryContact ? 'primary' : 'neutral'}>{active ? (guardian.isPrimaryContact ? '主要聯絡人' : '關聯監護人') : '待刪除審查'}</Tag>
    {studentActive && active && editing ? <GuardianProfileEditor guardian={guardian} onCancel={onCancel} onSaved={onSaved} onReload={onReload}/> : <>
      <FilledData missingLabel={count => t('caseUi.missing', { count })} items={[{ label: '與學生關係', value: relationshipLabel(guardian.relationshipType), filled: true }, { label: '聯絡方式', value: contact, filled: Boolean(contact) }, { label: '聯絡安排', value: flags.length ? flags.join(' · ') : '一般聯絡', filled: true }]}/>
    </>}
    {!active && <p className="ui-muted">這筆監護人資料仍會保留，但相關修改已受限制。</p>}
  </Card>;
}
function relationshipLabel(value: string): string {
    if (value === 'father')
        return '父親';
    if (value === 'mother')
        return '母親';
    if (value === 'other_guardian')
        return '其他監護人';
    return '監護人';
}
function formatDate(value: string): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '未提供' : date.toLocaleDateString('zh-HK');
}
function hasCapability(capabilities: readonly unknown[], expected: string): boolean {
    return capabilities.some((capability) => String(capability) === expected);
}
