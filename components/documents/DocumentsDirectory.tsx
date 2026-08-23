"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Icon } from "@/components/workspace/Icon";
import { getWorkspaceAccessSnapshot } from "@/modules/access/client";
import {
  DOCUMENT_CLASSIFICATIONS,
  DOCUMENT_LIFECYCLE_STATES,
  DOCUMENT_VERSION_STATES,
  classifyDocumentFailure,
  listDocuments,
  type DocumentClassification,
  type DocumentLifecycleState,
  type DocumentListItem,
  type DocumentVersionState,
} from "@/modules/documents/client";
import {
  DocumentList,
  DocumentPageState,
  classificationLabel,
  lifecycleLabel,
  versionStateLabel,
} from "./document-ui";

type LoadState = "loading" | "ready" | "unauthenticated" | "denied" | "unavailable";
type ClassificationFilter = "all" | DocumentClassification;
type LifecycleFilter = "all" | DocumentLifecycleState;
type VersionFilter = "all" | "none" | DocumentVersionState;

export function DocumentsDirectory() {
  const mounted = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [documents, setDocuments] = useState<readonly DocumentListItem[]>([]);
  const [classification, setClassification] = useState<ClassificationFilter>("all");
  const [lifecycle, setLifecycle] = useState<LifecycleFilter>("all");
  const [version, setVersion] = useState<VersionFilter>("all");

  const load = useCallback(async () => {
    controller.current?.abort();
    const nextController = new AbortController();
    controller.current = nextController;
    setState("loading");
    try {
      const [result, access] = await Promise.all([
        listDocuments(nextController.signal),
        getWorkspaceAccessSnapshot(nextController.signal),
      ]);
      if (!mounted.current || nextController.signal.aborted) return;
      if (!access.capabilities.some((capability) => String(capability) === "documents.read")) {
        setDocuments([]);
        setState("denied");
        return;
      }
      setDocuments(result.documents);
      setState("ready");
    } catch (error) {
      if (!mounted.current || nextController.signal.aborted) return;
      const failure = classifyDocumentFailure(error);
      setDocuments([]);
      setState(failure === "unauthenticated" ? "unauthenticated" : failure === "forbidden" ? "denied" : "unavailable");
    } finally {
      if (controller.current === nextController) controller.current = null;
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    queueMicrotask(() => { if (mounted.current) void load(); });
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, [load]);

  const filtered = documents.filter((document) =>
    (classification === "all" || document.classification === classification)
    && (lifecycle === "all" || document.lifecycle_state === lifecycle)
    && (version === "all" || (version === "none" ? document.latest_version_state === null : document.latest_version_state === version)),
  );

  return (
    <div className="max-w-[1100px] mx-auto space-y-6">
      <header>
        <div className="eyebrow">案件文件</div>
        <h2 className="page-title">文件</h2>
        <p className="page-subtitle">查看目前有權存取的案件文件資料和版本狀態。</p>
      </header>

      <section aria-labelledby="document-list-heading" aria-busy={state === "loading"}>
        <div className="pb-4 border-b space-y-4" style={{ borderColor: "var(--border)" }}>
          <div>
            <h3 id="document-list-heading" className="section-title">文件目錄</h3>
            <p className="section-detail" aria-live="polite">顯示 {filtered.length} / {documents.length} 份文件。</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Filter label="篩選文件分類" value={classification} disabled={state !== "ready"} onChange={(value) => setClassification(value as ClassificationFilter)}>
              <option value="all">全部分類</option>
              {DOCUMENT_CLASSIFICATIONS.map((value) => <option value={value} key={value}>{classificationLabel(value)}</option>)}
            </Filter>
            <Filter label="篩選文件狀態" value={lifecycle} disabled={state !== "ready"} onChange={(value) => setLifecycle(value as LifecycleFilter)}>
              <option value="all">全部文件狀態</option>
              {DOCUMENT_LIFECYCLE_STATES.map((value) => <option value={value} key={value}>{lifecycleLabel(value)}</option>)}
            </Filter>
            <Filter label="篩選版本狀態" value={version} disabled={state !== "ready"} onChange={(value) => setVersion(value as VersionFilter)}>
              <option value="all">全部版本狀態</option>
              <option value="none">等待上載</option>
              {DOCUMENT_VERSION_STATES.map((value) => <option value={value} key={value}>{versionStateLabel(value)}</option>)}
            </Filter>
          </div>
        </div>
        {state === "loading" ? <DocumentPageState title="正在載入文件" detail="請稍候。" /> : null}
        {state === "unauthenticated" ? <DocumentPageState title="工作階段已失效" detail="請重新登入後查看文件。" login /> : null}
        {state === "denied" ? <DocumentPageState title="無法查看文件" detail="目前帳號沒有查看文件的權限。" /> : null}
        {state === "unavailable" ? <DocumentPageState title="文件服務暫時不可用" detail="請稍後重試。" onRetry={() => void load()} /> : null}
        {state === "ready" && filtered.length === 0 ? <DocumentPageState title="目前沒有文件" detail="此篩選條件下沒有可顯示的文件。" /> : null}
        {state === "ready" && filtered.length > 0 ? <DocumentList documents={filtered} /> : null}
      </section>
    </div>
  );
}

function Filter({
  label,
  value,
  disabled,
  onChange,
  children,
}: {
  readonly label: string;
  readonly value: string;
  readonly disabled: boolean;
  readonly onChange: (value: string) => void;
  readonly children: React.ReactNode;
}) {
  return (
    <label className="select-field min-w-0">
      <Icon name="filter" size={15} />
      <span className="sr-only">{label}</span>
      <select aria-label={label} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>{children}</select>
    </label>
  );
}
