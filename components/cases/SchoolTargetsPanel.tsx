"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { ApiClientError } from "@/lib/api/client";
import {
  SchoolTargetIdempotencyAttempt,
  classifySchoolTargetFailure,
  createSchoolTarget,
  getSchoolTargets,
  hasSchoolTarget,
  type SchoolTargetCreateBlockedReason,
  type SchoolTargetItem,
  type SchoolTargetState,
  type SchoolTargetsView,
} from "@/modules/cases/client";
import { Icon } from "@/components/workspace/Icon";

type PanelStatus = "loading" | "ready" | "forbidden" | "unavailable" | "unauthenticated";
type NoticeKind = "success" | "duplicate" | "stale" | "unavailable";

interface PanelNotice {
  readonly kind: NoticeKind;
  readonly message: string;
  readonly requestId?: string;
}

export function SchoolTargetsPanel({ caseId }: { readonly caseId: string }) {
  const router = useRouter();
  const mountedRef = useRef(false);
  const loadControllerRef = useRef<AbortController | null>(null);
  const inFlightRef = useRef(false);
  const attemptRef = useRef<SchoolTargetIdempotencyAttempt | null>(null);
  if (attemptRef.current === null) attemptRef.current = new SchoolTargetIdempotencyAttempt();

  const [status, setStatus] = useState<PanelStatus>("loading");
  const [view, setView] = useState<SchoolTargetsView | null>(null);
  const [selectedSchoolId, setSelectedSchoolId] = useState("");
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<PanelNotice | null>(null);

  const applyLoadFailure = useCallback((error: unknown) => {
    if (isCallerAbort(error)) return;
    const failure = classifySchoolTargetFailure(error);
    if (failure === "unauthenticated") {
      setView(null);
      setStatus("unauthenticated");
      router.replace("/login");
      return;
    }
    if (failure === "forbidden") {
      setView(null);
      setStatus("forbidden");
      return;
    }
    setView(null);
    setStatus("unavailable");
    setNotice(unavailableNotice(error));
  }, [router]);

  const loadTargets = useCallback(async () => {
    loadControllerRef.current?.abort();
    const controller = new AbortController();
    loadControllerRef.current = controller;
    setStatus("loading");
    setNotice(null);
    try {
      const nextView = await getSchoolTargets(caseId, controller.signal);
      if (!mountedRef.current || controller.signal.aborted) return;
      setView(nextView);
      setStatus("ready");
    } catch (error) {
      if (mountedRef.current) applyLoadFailure(error);
    } finally {
      if (mountedRef.current && loadControllerRef.current === controller) {
        loadControllerRef.current = null;
      }
    }
  }, [applyLoadFailure, caseId]);

  useEffect(() => {
    mountedRef.current = true;
    void loadTargets();
    return () => {
      mountedRef.current = false;
      loadControllerRef.current?.abort();
    };
  }, [loadTargets]);

  function selectSchool(schoolId: string): void {
    attemptRef.current!.select(schoolId);
    setSelectedSchoolId(schoolId);
    setNotice(null);
  }

  async function submit(): Promise<void> {
    if (inFlightRef.current || creating || !view?.can_create || selectedSchoolId === "") return;
    const option = view.school_options.find(({ school_id }) => school_id === selectedSchoolId);
    if (!option) return;

    inFlightRef.current = true;
    setCreating(true);
    setNotice(null);
    const idempotencyKey = attemptRef.current!.keyFor(option.school_id);
    try {
      await createSchoolTarget(caseId, {
        school_id: option.school_id,
        expected_resolution_sha256: option.resolution_sha256,
      }, idempotencyKey);
      const nextView = await getSchoolTargets(caseId);
      if (!mountedRef.current) return;
      if (!hasSchoolTarget(nextView, option.school_id)) {
        throw new Error("Authoritative target was not returned after creation.");
      }
      attemptRef.current!.complete();
      setSelectedSchoolId("");
      setView(nextView);
      setStatus("ready");
      setNotice({ kind: "success", message: `${option.display_name} 已建立為候選學校目標。` });
    } catch (error) {
      if (mountedRef.current) await handleCreateFailure(error, option.school_id);
    } finally {
      inFlightRef.current = false;
      if (mountedRef.current) setCreating(false);
    }
  }

  async function handleCreateFailure(error: unknown, schoolId: string): Promise<void> {
    const failure = classifySchoolTargetFailure(error);
    if (failure === "unauthenticated") {
      setView(null);
      setStatus("unauthenticated");
      router.replace("/login");
      return;
    }
    if (failure === "forbidden") {
      attemptRef.current!.complete();
      setSelectedSchoolId("");
      setView(null);
      setStatus("forbidden");
      return;
    }
    if (failure === "stale") {
      attemptRef.current!.rotate();
      setSelectedSchoolId("");
      await refreshAfterMutationFailure({
        kind: "stale",
        message: "學校資料已經更新，請重新選擇學校後再建立。",
        requestId: requestIdOf(error),
      });
      return;
    }
    if (failure === "conflict") {
      try {
        const nextView = await getSchoolTargets(caseId);
        if (!mountedRef.current) return;
        setView(nextView);
        setStatus("ready");
        if (hasSchoolTarget(nextView, schoolId)) {
          attemptRef.current!.complete();
          setSelectedSchoolId("");
          setNotice({
            kind: "duplicate",
            message: "這所學校已經是本案的候選目標，列表已重新載入。",
            requestId: requestIdOf(error),
          });
        } else {
          setNotice({
            kind: "unavailable",
            message: "建立狀態仍在更新，請稍後重試。重試不會重複建立目標。",
            requestId: requestIdOf(error),
          });
        }
      } catch (refreshError) {
        applyMutationLoadFailure(refreshError);
      }
      return;
    }

    setNotice(unavailableNotice(error));
  }

  async function refreshAfterMutationFailure(nextNotice: PanelNotice): Promise<void> {
    try {
      const nextView = await getSchoolTargets(caseId);
      if (!mountedRef.current) return;
      setView(nextView);
      setStatus("ready");
      setNotice(nextNotice);
    } catch (error) {
      applyMutationLoadFailure(error);
    }
  }

  function applyMutationLoadFailure(error: unknown): void {
    const failure = classifySchoolTargetFailure(error);
    if (failure === "unauthenticated") {
      setView(null);
      setStatus("unauthenticated");
      router.replace("/login");
    } else if (failure === "forbidden") {
      setView(null);
      setStatus("forbidden");
    } else {
      setNotice(unavailableNotice(error));
    }
  }

  if (status === "loading") {
    return <StatePanel busy title="正在載入學校目標" detail="正在讀取本案的學校目標。" />;
  }
  if (status === "unauthenticated") {
    return <StatePanel title="登入已失效" detail="正在前往登入頁面。" />;
  }
  if (status === "forbidden") {
    return <StatePanel title="無法查看學校目標" detail="目前身份沒有查看此案件學校目標的權限。" />;
  }
  if (status === "unavailable" || view === null) {
    return (
      <StatePanel title="學校目標服務暫時不可用" detail="請稍後重新載入，已儲存的案件資料不受影響。">
        {notice?.requestId ? <RequestId value={notice.requestId} /> : null}
        <button type="button" className="secondary-button mt-3" onClick={() => void loadTargets()}>
          <Icon name="rotate-ccw" size={15} />重新載入
        </button>
      </StatePanel>
    );
  }

  const selectedOption = view.school_options.find(({ school_id }) => school_id === selectedSchoolId);

  return (
    <section
      className="workspace-section"
      aria-labelledby="school-targets-title"
      aria-busy={creating}
    >
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 mb-5">
        <div className="min-w-0">
          <h3 id="school-targets-title" className="section-title">學校目標</h3>
          <p className="section-detail">
            {view.items.length} 個目標 · {view.intake_year} · {admissionLabel(view.admission_type)}
          </p>
        </div>
        <span className="status-pill shrink-0">本案目標</span>
      </div>

      {notice ? <Notice notice={notice} /> : null}

      {view.items.length === 0 ? (
        <div className="empty-state" aria-live="polite">
          <Icon name="clipboard" size={20} />
          <strong>尚未建立學校目標</strong>
          <span>候選學校建立後會在這裡顯示，並在重新整理後繼續保留。</span>
        </div>
      ) : (
        <ul className="divide-y" style={{ borderColor: "var(--border-subtle)" }}>
          {view.items.map((item) => <TargetRow key={item.target_id} item={item} />)}
        </ul>
      )}

      {view.can_create ? (
        <form
          className="mt-5 pt-5 border-t"
          style={{ borderColor: "var(--border-subtle)" }}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="mb-4">
            <h4 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>建立候選目標</h4>
            <p id="school-target-create-detail" className="section-detail">
              入學年度和申請類型沿用本案設定。
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(150px,.35fr)_minmax(180px,.45fr)_auto] gap-3 md:items-end">
            <label className="field-label min-w-0">
              <span>學校</span>
              <select
                value={selectedSchoolId}
                disabled={creating}
                aria-describedby="school-target-create-detail"
                onChange={(event) => selectSchool(event.target.value)}
              >
                <option value="">選擇學校</option>
                {view.school_options.map((option) => (
                  <option key={option.school_id} value={option.school_id}>{option.display_name}</option>
                ))}
              </select>
            </label>
            <LockedField label="Intake year" value={String(view.intake_year)} />
            <LockedField label="Admission type" value={admissionLabel(view.admission_type)} />
            <button
              type="submit"
              className="primary-button md:self-end"
              disabled={creating || selectedOption === undefined}
            >
              <Icon name={creating ? "clock" : "plus"} size={15} />
              {creating ? "建立中…" : "建立候選目標"}
            </button>
          </div>
          {selectedOption ? (
            <p className="mt-2 text-xs break-words" style={{ color: "var(--text-muted)" }}>
              已選擇：{selectedOption.display_name}
            </p>
          ) : null}
        </form>
      ) : (
        <div className="inline-callout mt-5" role="status">
          <Icon name="shield" size={15} />
          <span>{blockedReasonLabel(view.create_blocked_reason)}</span>
        </div>
      )}
    </section>
  );
}

function TargetRow({ item }: { readonly item: SchoolTargetItem }) {
  return (
    <li className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_auto] gap-2 py-4 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <strong className="block text-sm break-words" style={{ color: "var(--text-primary)" }}>
          {item.school_name}
        </strong>
        <p className="mt-1 text-xs break-words" style={{ color: "var(--text-muted)" }}>
          {item.intake_year} · {admissionLabel(item.admission_type)} · 版本 {item.record_version}
        </p>
        <time className="mt-1 block text-xs" dateTime={item.created_at} style={{ color: "var(--text-muted)" }}>
          建立於 {formatCreatedAt(item.created_at)}
        </time>
      </div>
      <span className={`status-pill shrink-0 ${statusTone(item.state)}`}>{statusLabel(item.state)}</span>
    </li>
  );
}

function LockedField({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="field-label min-w-0">
      <span>{label}</span>
      <div className="locked-field min-w-0 break-words"><Icon name="lock" size={14} />{value}</div>
    </div>
  );
}

function Notice({ notice }: { readonly notice: PanelNotice }) {
  const isError = notice.kind === "stale" || notice.kind === "unavailable";
  return (
    <div className={`inline-callout mb-4 ${isError ? "warning" : ""}`} role={isError ? "alert" : "status"}>
      <Icon name={notice.kind === "success" ? "check-circle" : notice.kind === "stale" ? "clock" : "activity"} size={15} />
      <div className="min-w-0">
        <div>{notice.message}</div>
        {notice.requestId ? <RequestId value={notice.requestId} /> : null}
      </div>
    </div>
  );
}

function StatePanel({
  title,
  detail,
  busy = false,
  children,
}: {
  readonly title: string;
  readonly detail: string;
  readonly busy?: boolean;
  readonly children?: React.ReactNode;
}) {
  return (
    <section className="workspace-section" aria-live="polite" aria-busy={busy}>
      <div className="empty-state">
        <Icon name={busy ? "clock" : "shield"} size={20} />
        <strong>{title}</strong>
        <span>{detail}</span>
        {children}
      </div>
    </section>
  );
}

function RequestId({ value }: { readonly value: string }) {
  return <div className="mt-1 text-xs break-all" style={{ color: "var(--text-muted)" }}>支援編號：{value}</div>;
}

function unavailableNotice(error: unknown): PanelNotice {
  const requestId = requestIdOf(error);
  return {
    kind: "unavailable",
    message: "目前無法確認建立結果。請稍後重試；重試不會重複建立目標。",
    ...(requestId ? { requestId } : {}),
  };
}

function requestIdOf(error: unknown): string | undefined {
  return error instanceof ApiClientError && error.requestId ? error.requestId : undefined;
}

function isCallerAbort(error: unknown): boolean {
  return error instanceof ApiClientError && error.code === "REQUEST_ABORTED";
}

function blockedReasonLabel(reason: SchoolTargetCreateBlockedReason): string {
  if (reason === "founder_read_only") return "Founder 可以查看組織內目標，但本階段不允許建立學校目標。";
  if (reason === "case_stage_not_allowed") return "目前案件階段不允許建立新的學校目標。";
  if (reason === "no_school_options") return "目前沒有可新增的學校。";
  return "目前不能建立學校目標。";
}

function statusLabel(state: SchoolTargetState): string {
  const labels: Record<SchoolTargetState, string> = {
    candidate: "候選",
    preparing: "準備中",
    submitted: "已提交",
    interview: "面試",
    waitlisted: "候補",
    accepted: "已錄取",
    rejected: "未錄取",
    withdrawn: "已撤回",
  };
  return labels[state];
}

function statusTone(state: SchoolTargetState): string {
  if (state === "accepted") return "status-success";
  if (["waitlisted", "interview", "rejected", "withdrawn"].includes(state)) return "status-warning";
  return "";
}

function admissionLabel(value: string): string {
  if (value === "s1_admission") return "S1 入學";
  if (value === "transfer") return "插班";
  if (value === "hk_k12_standard_v1") return "HK K12 標準路徑";
  return value;
}

function formatCreatedAt(value: string): string {
  return new Intl.DateTimeFormat("zh-HK", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Hong_Kong",
  }).format(new Date(value));
}
