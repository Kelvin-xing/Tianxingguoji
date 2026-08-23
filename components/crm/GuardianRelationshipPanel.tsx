"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import { Icon } from "@/components/workspace/Icon";
import { ApiClientError } from "@/lib/api/client";
import { getWorkspaceAccessSnapshot } from "@/modules/access/client";
import {
  GuardianRelationshipIdempotencyAttempt,
  attachGuardianRelationship,
  classifyGuardianRelationshipFailure,
  getGuardianRelationships,
  getStudent,
  guardianAttachFingerprint,
  guardianHandoffFingerprint,
  handoffPrimaryGuardian,
  searchGuardians,
  type AttachGuardianRelationshipDraft,
  type CurrentGuardianRelationship,
  type GuardianContactHint,
  type GuardianRelationshipsView,
  type RelationshipType,
} from "@/modules/crm/client";

type PanelState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly view: GuardianRelationshipsView; readonly studentStatus: "active" | "pending_delete"; readonly canManage: boolean }
  | { readonly kind: "unauthenticated" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "unavailable" };

type SearchState =
  | { readonly kind: "idle" }
  | { readonly kind: "searching" }
  | { readonly kind: "ready"; readonly items: readonly GuardianContactHint[] }
  | { readonly kind: "validation"; readonly requestId: string | null }
  | { readonly kind: "forbidden"; readonly requestId: string | null }
  | { readonly kind: "unavailable"; readonly requestId: string | null };

type MutationNotice =
  | { readonly kind: "success" | "validation" | "conflict" | "stale" | "unavailable"; readonly requestId: string | null }
  | null;

const INITIAL_ATTACH_DRAFT: Omit<AttachGuardianRelationshipDraft, "guardian_id"> = {
  relationship_type: "father",
  is_legal_guardian: true,
  is_emergency_contact: false,
  is_billing_contact: false,
  notification_consent: false,
};

export function GuardianRelationshipPanel({ studentId }: { readonly studentId: string }) {
  const mountedRef = useRef(false);
  const searchControllerRef = useRef<AbortController | null>(null);
  const attachLockedRef = useRef(false);
  const handoffLockedRef = useRef(false);
  const attachAttemptRef = useRef<GuardianRelationshipIdempotencyAttempt | null>(null);
  const handoffAttemptRef = useRef<GuardianRelationshipIdempotencyAttempt | null>(null);
  if (attachAttemptRef.current === null) attachAttemptRef.current = new GuardianRelationshipIdempotencyAttempt("attach");
  if (handoffAttemptRef.current === null) handoffAttemptRef.current = new GuardianRelationshipIdempotencyAttempt("handoff");

  const [panel, setPanel] = useState<PanelState>({ kind: "loading" });
  const [reloadToken, setReloadToken] = useState(0);
  const [query, setQuery] = useState("");
  const [searchState, setSearchState] = useState<SearchState>({ kind: "idle" });
  const [selectedGuardian, setSelectedGuardian] = useState<GuardianContactHint | null>(null);
  const [attachDraft, setAttachDraft] = useState(INITIAL_ATTACH_DRAFT);
  const [attachPending, setAttachPending] = useState(false);
  const [attachNotice, setAttachNotice] = useState<MutationNotice>(null);
  const [successorSelection, setSuccessorSelection] = useState("");
  const [handoffConfirmed, setHandoffConfirmed] = useState(false);
  const [handoffPending, setHandoffPending] = useState(false);
  const [handoffNotice, setHandoffNotice] = useState<MutationNotice>(null);

  const applyLoadFailure = useCallback((error: unknown) => {
    const failure = classifyGuardianRelationshipFailure(error);
    if (failure === "unauthenticated") setPanel({ kind: "unauthenticated" });
    else if (failure === "forbidden" || failure === "not_found") setPanel({ kind: "forbidden" });
    else setPanel({ kind: "unavailable" });
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const controller = new AbortController();
    Promise.all([
      getGuardianRelationships(studentId, controller.signal),
      getStudent(studentId, controller.signal),
      getWorkspaceAccessSnapshot(controller.signal),
    ])
      .then(([view, student, access]) => {
        if (!mountedRef.current || controller.signal.aborted) return;
        setPanel({
          kind: "ready",
          view,
          studentStatus: student.status,
          canManage: student.status === "active" && access.capabilities.includes("students.guardians.manage"),
        });
      })
      .catch((error: unknown) => {
        if (mountedRef.current && !controller.signal.aborted) applyLoadFailure(error);
      });
    return () => {
      mountedRef.current = false;
      controller.abort();
      searchControllerRef.current?.abort();
    };
  }, [applyLoadFailure, reloadToken, studentId]);

  async function refreshRelationships(): Promise<void> {
    const [view, student] = await Promise.all([
      getGuardianRelationships(studentId),
      getStudent(studentId),
    ]);
    if (mountedRef.current) setPanel((current) => current.kind === "ready" ? {
      ...current,
      view,
      studentStatus: student.status,
      canManage: current.canManage && student.status === "active",
    } : current);
  }

  async function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (panel.kind !== "ready" || panel.studentStatus !== "active" || !panel.canManage || searchState.kind === "searching") return;
    const normalizedQuery = query.trim();
    if (normalizedQuery.length < 2 || normalizedQuery.length > 100) {
      setSearchState({ kind: "validation", requestId: null });
      return;
    }
    searchControllerRef.current?.abort();
    const controller = new AbortController();
    searchControllerRef.current = controller;
    setSelectedGuardian(null);
    setAttachNotice(null);
    setSearchState({ kind: "searching" });
    try {
      const items = await searchGuardians(studentId, normalizedQuery, controller.signal);
      if (!mountedRef.current || controller.signal.aborted) return;
      setSearchState({ kind: "ready", items });
    } catch (error) {
      if (!mountedRef.current || controller.signal.aborted) return;
      const failure = classifyGuardianRelationshipFailure(error);
      if (failure === "unauthenticated") setPanel({ kind: "unauthenticated" });
      else if (failure === "forbidden") setSearchState({ kind: "forbidden", requestId: requestIdOf(error) });
      else if (failure === "validation") setSearchState({ kind: "validation", requestId: requestIdOf(error) });
      else setSearchState({ kind: "unavailable", requestId: requestIdOf(error) });
    } finally {
      if (searchControllerRef.current === controller) searchControllerRef.current = null;
    }
  }

  function changeAttachDraft<Key extends keyof typeof INITIAL_ATTACH_DRAFT>(key: Key, value: (typeof INITIAL_ATTACH_DRAFT)[Key]) {
    setAttachDraft((current) => ({ ...current, [key]: value }));
    setAttachNotice(null);
  }

  async function handleAttach(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (panel.kind !== "ready" || panel.studentStatus !== "active" || !panel.canManage || selectedGuardian === null || attachLockedRef.current || attachPending) return;
    const draft: AttachGuardianRelationshipDraft = { guardian_id: selectedGuardian.id, ...attachDraft };
    attachLockedRef.current = true;
    setAttachPending(true);
    setAttachNotice(null);
    try {
      const key = attachAttemptRef.current!.keyFor(guardianAttachFingerprint(draft));
      await attachGuardianRelationship(studentId, draft, key);
      await refreshRelationships();
      attachAttemptRef.current!.complete();
      setSelectedGuardian(null);
      setSearchState({ kind: "idle" });
      setQuery("");
      setAttachDraft(INITIAL_ATTACH_DRAFT);
      setAttachNotice({ kind: "success", requestId: null });
    } catch (error) {
      applyMutationFailure(error, "attach");
    } finally {
      attachLockedRef.current = false;
      if (mountedRef.current) setAttachPending(false);
    }
  }

  async function handleHandoff(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (panel.kind !== "ready" || panel.studentStatus !== "active" || !panel.canManage || !handoffConfirmed || successorSelection === "" || handoffLockedRef.current || handoffPending) return;
    const primary = currentPrimary(panel.view.relationships);
    const successor = currentSecondaries(panel.view.relationships)[Number(successorSelection)];
    if (!primary || !successor) return;

    handoffLockedRef.current = true;
    setHandoffPending(true);
    setHandoffNotice(null);
    try {
      const fingerprint = guardianHandoffFingerprint(successor.guardian.id, primary.record_version);
      const key = handoffAttemptRef.current!.keyFor(fingerprint);
      await handoffPrimaryGuardian(studentId, successor.guardian.id, primary.record_version, key);
      await refreshRelationships();
      handoffAttemptRef.current!.complete();
      setSuccessorSelection("");
      setHandoffConfirmed(false);
      setHandoffNotice({ kind: "success", requestId: null });
    } catch (error) {
      const failure = classifyGuardianRelationshipFailure(error);
      if (failure === "stale") {
        handoffAttemptRef.current!.rotate();
        setSuccessorSelection("");
        setHandoffConfirmed(false);
        try {
          await refreshRelationships();
        } catch (refreshError) {
          applyMutationFailure(refreshError, "handoff");
          return;
        }
      }
      applyMutationFailure(error, "handoff");
    } finally {
      handoffLockedRef.current = false;
      if (mountedRef.current) setHandoffPending(false);
    }
  }

  function applyMutationFailure(error: unknown, operation: "attach" | "handoff") {
    const failure = classifyGuardianRelationshipFailure(error);
    if (failure === "unauthenticated") {
      setPanel({ kind: "unauthenticated" });
      return;
    }
    if (failure === "forbidden") {
      setPanel((current) => current.kind === "ready" ? { ...current, canManage: false } : current);
      return;
    }
    const notice: MutationNotice = {
      kind: failure === "validation" ? "validation" : failure === "stale" ? "stale" : failure === "conflict" ? "conflict" : "unavailable",
      requestId: requestIdOf(error),
    };
    if (operation === "attach") setAttachNotice(notice);
    else setHandoffNotice(notice);
  }

  if (panel.kind === "loading") return <PageState busy title="正在載入監護人關係" detail="請稍候。" />;
  if (panel.kind === "unauthenticated") return <PageState title="工作階段已失效" detail="請重新登入後再查看監護人關係。" href="/login" action="重新登入" />;
  if (panel.kind === "forbidden") return <PageState title="無法查看監護人關係" detail="你的帳號目前沒有查看此學生的權限。" href="/students" action="返回學生名單" />;
  if (panel.kind === "unavailable") return <PageState title="監護人服務暫時不可用" detail="請稍後重試。" onRetry={() => { setPanel({ kind: "loading" }); setReloadToken((value) => value + 1); }} />;

  const primary = currentPrimary(panel.view.relationships);
  const secondaries = currentSecondaries(panel.view.relationships);
  const successor = successorSelection === "" ? null : secondaries[Number(successorSelection)] ?? null;
  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div className="flex items-center gap-2 text-xs" style={{ color: "var(--text-muted)" }}>
        <Link href={`/students/${studentId}`} className="quiet-link">{panel.view.student.display_name}</Link>
        <Icon name="chevron-right" size={14} />
        <span>監護人關係</span>
      </div>
      <header><div className="eyebrow">學生資料</div><h2 className="page-title">監護人關係管理</h2><p className="page-subtitle">查看目前關係；有管理權限時可人工關聯既有監護人或交接主要聯絡人。</p></header>

      <section className="workspace-section" aria-labelledby="current-relationships-heading">
        <SectionHeading id="current-relationships-heading" title="目前監護人關係" detail="主要聯絡人優先顯示，聯絡資料只顯示脫敏提示。" count={panel.view.relationships.length} />
        <RelationshipList relationships={panel.view.relationships} />
      </section>

      {panel.studentStatus === "pending_delete" ? <div className="inline-callout" role="status"><Icon name="lock" size={15} /><span>這筆學生資料正在進行待刪除審查。現有關係與歷史仍會保留，但關聯監護人和交接主要聯絡人已受限制。</span></div> : <>
      <section className="workspace-section space-y-5" aria-labelledby="attach-guardian-heading">
        <SectionHeading id="attach-guardian-heading" title="關聯已有監護人" detail="輸入至少兩個字元並人工選擇結果；系統不會自動匹配或建立新監護人。" />
        {!panel.canManage ? <ReadOnlyNotice /> : <>
          <form className="flex flex-col sm:flex-row gap-2" onSubmit={handleSearch} noValidate>
            <label className="field-label flex-1" htmlFor="guardian-search-query">姓名或聯絡線索
              <input id="guardian-search-query" value={query} onChange={(event) => { searchControllerRef.current?.abort(); setQuery(event.target.value); setSearchState({ kind: "idle" }); setSelectedGuardian(null); setAttachNotice(null); }} minLength={2} maxLength={100} autoComplete="off" required />
            </label>
            <button type="submit" className="secondary-button sm:self-end" disabled={searchState.kind === "searching"} aria-busy={searchState.kind === "searching"}><Icon name={searchState.kind === "searching" ? "clock" : "search"} size={15} />{searchState.kind === "searching" ? "搜尋中…" : "搜尋"}</button>
          </form>
          <SearchFeedback state={searchState} selectedGuardianId={selectedGuardian?.id ?? null} onSelect={(candidate) => { setSelectedGuardian(candidate); setAttachNotice(null); }} />
          {selectedGuardian
            ? <AttachForm draft={attachDraft} selected={selectedGuardian} pending={attachPending} notice={attachNotice} onChange={changeAttachDraft} onSubmit={handleAttach} />
            : <MutationFeedback operation="attach" notice={attachNotice} />}
        </>}
      </section>

      <section className="workspace-section space-y-5" aria-labelledby="handoff-primary-heading">
        <SectionHeading id="handoff-primary-heading" title="交接主要聯絡人" detail="只能從目前次要聯絡人中選擇新的主要聯絡人。" />
        <MutationFeedback operation="handoff" notice={handoffNotice} />
        {!panel.canManage ? <ReadOnlyNotice /> : primary === null
          ? <InlineError message="目前找不到主要聯絡人，暫時無法交接。請重新載入後再試。" requestId={null} />
          : secondaries.length === 0 ? <div className="empty-state">目前沒有可交接的次要聯絡人。</div>
          : <form className="space-y-4" onSubmit={handleHandoff}>
              <label className="field-label" htmlFor="successor-guardian">新的主要聯絡人
                <select id="successor-guardian" value={successorSelection} onChange={(event) => { setSuccessorSelection(event.target.value); setHandoffConfirmed(false); setHandoffNotice(null); }} required>
                  <option value="">請選擇目前次要聯絡人</option>
                  {secondaries.map((relationship, index) => <option key={relationship.relationship_id} value={String(index)}>{relationship.guardian.display_name}</option>)}
                </select>
              </label>
              {successor ? <div className="inline-callout"><Icon name="users" size={15} /><span>將由「{primary.guardian.display_name}」交接給「{successor.guardian.display_name}」。既有歷史會保留，也不會刪除任何監護人。</span></div> : null}
              <label className="flex items-start gap-3 text-sm" style={{ color: "var(--text-secondary)" }}><input type="checkbox" checked={handoffConfirmed} onChange={(event) => { setHandoffConfirmed(event.target.checked); setHandoffNotice(null); }} disabled={!successor} className="mt-1" /><span>我已核對交接對象，並確認保留既有歷史與所有監護人資料。</span></label>
              <button type="submit" className="primary-button" disabled={!successor || !handoffConfirmed || handoffPending} aria-busy={handoffPending}><Icon name={handoffPending ? "clock" : "check"} size={15} />{handoffPending ? "交接中…" : "確認交接主要聯絡人"}</button>
            </form>}
      </section>
      </>}
    </div>
  );
}

function AttachForm({ draft, selected, pending, notice, onChange, onSubmit }: {
  readonly draft: typeof INITIAL_ATTACH_DRAFT;
  readonly selected: GuardianContactHint;
  readonly pending: boolean;
  readonly notice: MutationNotice;
  readonly onChange: <Key extends keyof typeof INITIAL_ATTACH_DRAFT>(key: Key, value: (typeof INITIAL_ATTACH_DRAFT)[Key]) => void;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return <form className="space-y-4 border-t pt-5" style={{ borderColor: "var(--border-subtle)" }} onSubmit={onSubmit}>
    <div className="inline-callout"><Icon name="check-circle" size={15} /><span>已選擇：<strong>{selected.display_name}</strong> · {contactHint(selected)}</span></div>
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <label className="field-label" htmlFor="attach-relationship-type">與學生關係<select id="attach-relationship-type" value={draft.relationship_type} onChange={(event) => onChange("relationship_type", event.target.value as RelationshipType)} required><option value="father">父親</option><option value="mother">母親</option><option value="other_guardian">其他監護人</option></select></label>
      <Flag label="法定監護人" checked={draft.is_legal_guardian} onChange={(value) => onChange("is_legal_guardian", value)} />
      <Flag label="緊急聯絡人" checked={draft.is_emergency_contact} onChange={(value) => onChange("is_emergency_contact", value)} />
      <Flag label="帳務聯絡人" checked={draft.is_billing_contact} onChange={(value) => onChange("is_billing_contact", value)} />
      <Flag label="接收通知" checked={draft.notification_consent} onChange={(value) => onChange("notification_consent", value)} />
    </div>
    <MutationFeedback operation="attach" notice={notice} />
    <button type="submit" className="primary-button" disabled={pending} aria-busy={pending}><Icon name={pending ? "clock" : "plus"} size={15} />{pending ? "關聯中…" : "確認關聯為次要監護人"}</button>
  </form>;
}

function SearchFeedback({ state, selectedGuardianId, onSelect }: { readonly state: SearchState; readonly selectedGuardianId: string | null; readonly onSelect: (candidate: GuardianContactHint) => void }) {
  if (state.kind === "idle") return null;
  if (state.kind === "searching") return <div role="status" className="inline-callout"><Icon name="clock" size={15} /><span>正在搜尋可關聯的監護人。</span></div>;
  if (state.kind === "validation") return <InlineError message="請輸入 2 至 100 個字元後再搜尋。" requestId={state.requestId} />;
  if (state.kind === "forbidden") return <InlineError message="你的帳號目前無法搜尋可關聯的監護人。" requestId={state.requestId} />;
  if (state.kind === "unavailable") return <InlineError message="監護人搜尋暫時不可用，請稍後重試。" requestId={state.requestId} />;
  if (state.items.length === 0) return <div className="empty-state">沒有找到可關聯的監護人。請調整搜尋內容後再試。</div>;
  return <fieldset className="space-y-2"><legend className="text-xs font-semibold mb-2" style={{ color: "var(--text-secondary)" }}>搜尋結果，請明確選擇一位監護人</legend>{state.items.map((candidate) => {
    const selected = candidate.id === selectedGuardianId;
    return <label key={candidate.id} className={`selection-card ${selected ? "selected" : ""}`}><input type="radio" name="guardian-candidate" checked={selected} onChange={() => onSelect(candidate)} /><span className="selection-mark">{selected ? <Icon name="check" size={12} /> : null}</span><span className="min-w-0"><strong className="break-words">{candidate.display_name}</strong><small className="break-words">{contactHint(candidate)}</small></span></label>;
  })}</fieldset>;
}

function RelationshipList({ relationships }: { readonly relationships: readonly CurrentGuardianRelationship[] }) {
  if (relationships.length === 0) return <div className="empty-state">目前沒有有效監護人關係。</div>;
  return <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">{relationships.map((relationship) => <RelationshipCard key={relationship.relationship_id} relationship={relationship} />)}</div>;
}

function RelationshipCard({ relationship }: { readonly relationship: CurrentGuardianRelationship }) {
  const flags = [relationship.is_legal_guardian && "法定監護", relationship.is_emergency_contact && "緊急聯絡", relationship.is_billing_contact && "帳務聯絡", relationship.notification_consent && "接收通知"].filter(Boolean);
  return <article className="selection-card selected"><span className="work-icon blue"><Icon name="user" size={15} /></span><span className="min-w-0 flex-1"><strong className="break-words">{relationship.guardian.display_name}</strong><small className="break-words">{relationshipLabel(relationship.relationship_type)} · {contactHint(relationship.guardian)}</small><small>{flags.length > 0 ? flags.join(" · ") : "一般聯絡"}</small></span><span className={`status-pill ${relationship.is_primary_contact ? "status-success" : "status-warning"} shrink-0`}>{relationship.is_primary_contact ? "主要聯絡人" : "次要聯絡人"}</span></article>;
}

function MutationFeedback({ operation, notice }: { readonly operation: "attach" | "handoff"; readonly notice: MutationNotice }) {
  if (!notice) return null;
  const messages = operation === "attach"
    ? { success: "已關聯次要監護人，列表已重新載入。", validation: "部分關係設定未通過檢查，請確認後再提交。", conflict: "這位監護人的目前關係已變更，請重新搜尋並核對後再試。", stale: "監護人關係已更新，請重新載入後再試。", unavailable: "關聯結果暫時無法確認，請稍後重試；重試不會重複建立關係。" }
    : { success: "主要聯絡人已完成交接，列表已重新載入。", validation: "交接資料未通過檢查，請重新選擇後再提交。", conflict: "目前關係已變更，請重新核對交接對象後再試。", stale: "主要聯絡人資料已更新，請依最新列表重新選擇。", unavailable: "交接結果暫時無法確認，請稍後重試；重試不會重複交接。" };
  if (notice.kind === "success") return <div className="preview-notice" role="status"><Icon name="check-circle" size={15} /><span>{messages.success}</span></div>;
  return <InlineError message={messages[notice.kind]} requestId={notice.requestId} />;
}

function Flag({ label, checked, onChange }: { readonly label: string; readonly checked: boolean; readonly onChange: (value: boolean) => void }) {
  return <label className="flex items-start gap-3 text-sm" style={{ color: "var(--text-secondary)" }}><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="mt-1" /><span>{label}</span></label>;
}

function SectionHeading({ id, title, detail, count }: { readonly id: string; readonly title: string; readonly detail: string; readonly count?: number }) {
  return <div className="flex items-start justify-between gap-3 mb-4"><div><h3 id={id} className="section-title">{title}</h3><p className="section-detail">{detail}</p></div>{count !== undefined ? <span className="text-xs shrink-0" style={{ color: "var(--text-muted)" }}>{count} 筆</span> : null}</div>;
}

function ReadOnlyNotice() {
  return <div className="inline-callout"><Icon name="lock" size={15} /><span>目前為只讀模式。管理入口的隱藏只改善使用體驗，每次操作仍由服務端獨立驗證權限。</span></div>;
}

function InlineError({ message, requestId }: { readonly message: string; readonly requestId: string | null }) {
  return <div className="form-error" role="alert"><Icon name="x" size={15} /><span>{message}{requestId ? <small className="block mt-1">參考編號：{requestId}</small> : null}</span></div>;
}

function PageState({ busy, title, detail, href, action, onRetry }: { readonly busy?: boolean; readonly title: string; readonly detail: string; readonly href?: string; readonly action?: string; readonly onRetry?: () => void }) {
  return <div className="max-w-3xl mx-auto"><section className="workspace-section" aria-busy={busy}><div className="empty-state"><Icon name={busy ? "clock" : "shield"} size={20} /><strong>{title}</strong><span className="block mt-1">{detail}</span>{href && action ? <Link href={href} className="primary-button mt-3">{action}</Link> : null}{onRetry ? <button type="button" className="secondary-button mt-3" onClick={onRetry}>重新載入</button> : null}</div></section></div>;
}

function currentPrimary(relationships: readonly CurrentGuardianRelationship[]): CurrentGuardianRelationship | null {
  return relationships.find(({ is_primary_contact }) => is_primary_contact) ?? null;
}

function currentSecondaries(relationships: readonly CurrentGuardianRelationship[]): readonly CurrentGuardianRelationship[] {
  return relationships.filter(({ is_primary_contact }) => !is_primary_contact);
}

function relationshipLabel(value: RelationshipType): string {
  if (value === "father") return "父親";
  if (value === "mother") return "母親";
  return "其他監護人";
}

function contactHint(guardian: GuardianContactHint): string {
  return [guardian.email_hint, guardian.phone_hint].filter(Boolean).join(" · ") || "未提供聯絡提示";
}

function requestIdOf(error: unknown): string | null {
  return error instanceof ApiClientError ? error.requestId : null;
}
