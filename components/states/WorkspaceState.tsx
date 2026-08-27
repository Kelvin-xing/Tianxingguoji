import type { ReactNode } from "react";

import { Icon, type IconName } from "@/components/workspace/Icon";

export type WorkspaceStateKind = "loading" | "empty" | "error" | "denied" | "unavailable" | "stale" | "success";

interface WorkspaceStateProps {
  readonly kind: WorkspaceStateKind;
  readonly title: string;
  readonly detail?: string;
  readonly requestId?: string | null;
  readonly action?: ReactNode;
  readonly onRetry?: () => void;
  readonly retryLabel?: string;
}

const STATE_ICONS: Readonly<Record<WorkspaceStateKind, IconName>> = {
  loading: "clock",
  empty: "briefcase",
  error: "x",
  denied: "shield",
  unavailable: "activity",
  stale: "rotate-ccw",
  success: "check-circle",
};

export function WorkspaceState({ kind, title, detail, requestId, action, onRetry, retryLabel = "重新載入" }: WorkspaceStateProps) {
  const isLoading = kind === "loading";
  const isSuccess = kind === "success";
  const role = isLoading || isSuccess ? "status" : "alert";
  const safeRequestId = requestId && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(requestId) ? requestId : null;

  return (
    <section className="workspace-state" role={role} aria-live="polite" aria-busy={isLoading || undefined}>
      <div className={`workspace-state-icon workspace-state-${kind}`} aria-hidden="true">
        <Icon name={STATE_ICONS[kind]} size={20} />
      </div>
      <h2 className="workspace-state-title">{title}</h2>
      {detail ? <p className="workspace-state-detail">{detail}</p> : null}
      {safeRequestId ? <p className="workspace-state-request">參考編號：{safeRequestId}</p> : null}
      {onRetry ? <button type="button" className="secondary-button mt-4" onClick={onRetry}>{retryLabel}</button> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </section>
  );
}

export function LoadingState(props: Omit<WorkspaceStateProps, "kind">) {
  return <WorkspaceState {...props} kind="loading" />;
}

export function EmptyState(props: Omit<WorkspaceStateProps, "kind">) {
  return <WorkspaceState {...props} kind="empty" />;
}

export function ErrorState(props: Omit<WorkspaceStateProps, "kind">) {
  return <WorkspaceState {...props} kind="error" />;
}

export function DeniedState(props: Omit<WorkspaceStateProps, "kind">) {
  return <WorkspaceState {...props} kind="denied" />;
}

export function UnavailableState(props: Omit<WorkspaceStateProps, "kind">) {
  return <WorkspaceState {...props} kind="unavailable" />;
}

export function StaleState(props: Omit<WorkspaceStateProps, "kind">) {
  return <WorkspaceState {...props} kind="stale" />;
}

export function SuccessState(props: Omit<WorkspaceStateProps, "kind">) {
  return <WorkspaceState {...props} kind="success" />;
}
