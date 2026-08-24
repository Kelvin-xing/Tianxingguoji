import Link from "next/link";

import { Icon } from "@/components/workspace/Icon";
import type { ReactNode } from "react";

import type {
  DocumentClassification,
  DocumentLifecycleState,
  DocumentListItem,
  DocumentVersionState,
} from "@/modules/documents/client";

export function DocumentList({
  documents,
  renderActions,
}: {
  readonly documents: readonly DocumentListItem[];
  readonly renderActions?: (document: DocumentListItem) => ReactNode;
}) {
  return (
    <ul className="divide-y" style={{ borderColor: "var(--border-subtle)" }}>
      {documents.map((document) => <DocumentListRow document={document} key={document.id}>{renderActions?.(document)}</DocumentListRow>)}
    </ul>
  );
}

export function DocumentListRow({ document, children }: { readonly document: DocumentListItem; readonly children?: ReactNode }) {
  return (
    <li className="py-4 min-w-0">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 min-w-0">
        <div className="min-w-0 space-y-2">
          <div className="flex items-start gap-2 min-w-0">
            <span className="work-icon blue shrink-0"><Icon name="file-text" size={15} /></span>
            <div className="min-w-0">
              <p className="table-primary break-words">{document.display_name}</p>
              <Link href={`/cases/${document.case_id}#documents`} className="quiet-link text-xs break-words">
                案件 {document.case_number}
              </Link>
            </div>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs" style={{ color: "var(--text-muted)" }}>
            <span>{classificationLabel(document.classification)}</span>
            <span>{lifecycleLabel(document.lifecycle_state)}</span>
            <time dateTime={document.updated_at}>更新於 {formatDocumentDate(document.updated_at)}</time>
          </div>
        </div>
        <DocumentVersionPill state={document.latest_version_state} />
      </div>
      {children}
    </li>
  );
}

export function DocumentVersionPill({ state }: { readonly state: DocumentVersionState | null }) {
  const tone = state === "available" ? "status-success"
    : state === "rejected" || state === "scan_failed" || state === "abandoned" || state === "deleted" ? "status-warning"
      : "";
  return <span className={`status-pill shrink-0 ${tone}`}>{versionStateLabel(state)}</span>;
}

export function DocumentPageState({
  title,
  detail,
  login,
  onRetry,
}: {
  readonly title: string;
  readonly detail: string;
  readonly login?: boolean;
  readonly onRetry?: () => void;
}) {
  return (
    <div className="empty-state">
      <Icon name={onRetry ? "x" : "file-text"} size={20} />
      <strong>{title}</strong>
      <span>{detail}</span>
      {login ? <Link href="/login" className="primary-button mt-3">重新登入</Link> : null}
      {onRetry ? <button type="button" className="secondary-button mt-3" onClick={onRetry}>重新載入</button> : null}
    </div>
  );
}

export function classificationLabel(value: DocumentClassification): string {
  return value === "identity_and_case_evidence" ? "身份與案件證明" : "業務附件";
}

export function lifecycleLabel(value: DocumentLifecycleState): string {
  return value === "active" ? "使用中" : "待刪除審核";
}

export function versionStateLabel(value: DocumentVersionState | null): string {
  if (value === null) return "等待上載";
  const labels: Readonly<Record<DocumentVersionState, string>> = {
    pending_upload: "等待上載",
    quarantined: "隔離中",
    scanning: "掃描中",
    available: "可使用",
    rejected: "已拒絕",
    scan_failed: "掃描失敗",
    abandoned: "已放棄",
    superseded: "已由新版本取代",
    pending_delete: "待刪除審核",
    deleted: "已刪除",
  };
  return labels[value];
}

function formatDocumentDate(value: string): string {
  return new Intl.DateTimeFormat("zh-HK", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Hong_Kong",
  }).format(new Date(value));
}
