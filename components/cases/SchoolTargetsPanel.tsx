"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";

import { Icon } from "@/components/workspace/Icon";
import {
  classifySchoolTargetFailure,
  getSchoolTargets,
  type SchoolTargetItem,
  type SchoolTargetState,
  type SchoolTargetsView,
} from "@/modules/cases/client";

type PanelStatus = "loading" | "ready" | "forbidden" | "unavailable" | "unauthenticated";

export function SchoolTargetsPanel({ caseId }: { readonly caseId: string }) {
  const router = useRouter();
  const mounted = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const [status, setStatus] = useState<PanelStatus>("loading");
  const [view, setView] = useState<SchoolTargetsView | null>(null);

  const load = useCallback(async () => {
    controller.current?.abort();
    const nextController = new AbortController();
    controller.current = nextController;
    setStatus("loading");
    try {
      const nextView = await getSchoolTargets(caseId, nextController.signal);
      if (!mounted.current || nextController.signal.aborted) return;
      setView(nextView);
      setStatus("ready");
    } catch (error: unknown) {
      if (!mounted.current || nextController.signal.aborted) return;
      const failure = classifySchoolTargetFailure(error);
      setView(null);
      if (failure === "unauthenticated") {
        setStatus("unauthenticated");
        router.replace("/login");
      } else if (failure === "forbidden") {
        setStatus("forbidden");
      } else {
        setStatus("unavailable");
      }
    } finally {
      if (controller.current === nextController) controller.current = null;
    }
  }, [caseId, router]);

  useEffect(() => {
    mounted.current = true;
    queueMicrotask(() => { if (mounted.current) void load(); });
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, [load]);

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
        <button type="button" className="secondary-button mt-3" onClick={() => void load()}>
          <Icon name="rotate-ccw" size={15} />重新載入
        </button>
      </StatePanel>
    );
  }

  return (
    <section className="workspace-section" aria-labelledby="school-targets-title">
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 mb-5">
        <div className="min-w-0">
          <h3 id="school-targets-title" className="section-title">學校目標</h3>
          <p className="section-detail">
            {view.items.length} 個目標 · {view.intake_year} · {admissionLabel(view.admission_type)}
          </p>
        </div>
        <span className="status-pill shrink-0">只讀</span>
      </div>

      {view.items.length === 0 ? (
        <div className="empty-state" aria-live="polite">
          <Icon name="clipboard" size={20} />
          <strong>尚未建立學校目標</strong>
          <span>已核准的選校流程建立目標後，會在這裡顯示。</span>
        </div>
      ) : (
        <ul className="divide-y" style={{ borderColor: "var(--border-subtle)" }}>
          {view.items.map((item) => <TargetRow key={item.target_id} item={item} />)}
        </ul>
      )}

      <div className="inline-callout mt-5" role="status">
        <Icon name="shield" size={15} />
        <span>此處只顯示現有目標；新增與流程變更由已核准的選校流程處理。</span>
      </div>
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

function StatePanel({
  busy = false,
  title,
  detail,
  children,
}: {
  readonly busy?: boolean;
  readonly title: string;
  readonly detail: string;
  readonly children?: ReactNode;
}) {
  return (
    <section className="workspace-section" aria-busy={busy}>
      <h3 className="section-title">{title}</h3>
      <p className="section-detail">{detail}</p>
      {children}
    </section>
  );
}

function admissionLabel(value: string): string {
  return value === "s1_admission" ? "中一入學" : value === "transfer" ? "插班" : value;
}

function statusLabel(state: SchoolTargetState): string {
  if (state === "candidate") return "候選";
  if (state === "preparing") return "準備中";
  if (state === "submitted") return "已提交";
  if (state === "interview") return "面試";
  if (state === "waitlisted") return "候補";
  if (state === "accepted") return "已錄取";
  if (state === "rejected") return "未錄取";
  return "已撤回";
}

function statusTone(state: SchoolTargetState): string {
  if (state === "accepted") return "status-success";
  if (state === "rejected" || state === "withdrawn") return "status-danger";
  if (state === "submitted" || state === "interview" || state === "waitlisted") return "status-warning";
  return "";
}

function formatCreatedAt(value: string): string {
  return new Intl.DateTimeFormat("zh-HK", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Hong_Kong",
  }).format(new Date(value));
}
