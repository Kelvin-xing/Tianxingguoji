import Link from "next/link";

import { Icon } from "@/components/workspace/Icon";
import type {
  AssignedTask,
  CaseWorkspaceTask,
  TaskAudience,
  TaskKind,
} from "@/modules/tasks/client";
import type { TaskState } from "@/modules/tasks/public";

export type TaskViewItem = CaseWorkspaceTask | AssignedTask;

export function TaskStatePill({ state }: { readonly state: TaskState }) {
  const tone = state === "approved" || state === "completed"
    ? "status-success"
    : state === "rejected" || state === "cancelled" || state === "overdue"
      ? "status-warning"
      : "";
  return <span className={`status-pill ${tone}`}>{taskStateLabel(state)}</span>;
}

export function TaskAudienceNotice({ audience }: { readonly audience: TaskAudience }) {
  if (audience === "case_workspace") return null;
  return (
    <div className="inline-callout" role="status">
      <Icon name="shield" size={15} />
      <span>此工作清單只顯示指派任務內容，不包含案件或學生資料。</span>
    </div>
  );
}

export function TaskKindPill({ kind }: { readonly kind: TaskKind }) {
  const label = kind === "application_prepare_submit" ? "申請提交"
    : kind === "interview_support" ? "面試支援"
      : "手工任務";
  return <span className="status-pill">{label}</span>;
}

export function TaskListItem({ task }: { readonly task: TaskViewItem }) {
  const internal = "case_id" in task;
  return (
    <li className="py-4 border-b last:border-b-0" style={{ borderColor: "var(--border-subtle)" }}>
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 min-w-0">
        <div className="min-w-0 space-y-1">
          <Link href={`/tasks/${task.id}`} className="table-primary break-words">{task.title}</Link>
          <p className="text-sm leading-6 break-words line-clamp-2" style={{ color: "var(--text-secondary)" }}>
            {task.task_brief}
          </p>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs" style={{ color: "var(--text-muted)" }}>
            <span>到期：<time dateTime={task.due_at}>{formatTaskDate(task.due_at)}</time></span>
            {internal ? <Link href={`/cases/${task.case_id}`} className="quiet-link">案件 {task.case_number}</Link> : null}
            {internal ? <span>負責人：{task.assignee.label}</span> : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <TaskKindPill kind={task.task_kind} />
          {task.is_overdue ? <span className="status-pill status-warning">已逾期</span> : null}
          <TaskStatePill state={task.state} />
        </div>
      </div>
    </li>
  );
}

export function TaskPageState({
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
      <Icon name={onRetry ? "x" : "clipboard"} size={20} />
      <strong>{title}</strong>
      <span>{detail}</span>
      {login ? <Link href="/login" className="primary-button mt-3">重新登入</Link> : null}
      {onRetry ? <button type="button" className="secondary-button mt-3" onClick={onRetry}>重新載入</button> : null}
    </div>
  );
}

export function taskStateLabel(state: TaskState): string {
  const labels: Readonly<Record<TaskState, string>> = {
    created: "已建立",
    assigned: "已指派",
    accepted: "已接受",
    awaiting_reassignment: "等待重新指派",
    rejected: "已拒絕",
    reassigned: "已重新指派",
    completed: "已完成",
    approved: "已批准",
    overdue: "已逾期",
    cancelled: "已取消",
  };
  return labels[state];
}

export function transitionLabel(state: TaskState): string {
  const labels: Partial<Readonly<Record<TaskState, string>>> = {
    accepted: "接受任務",
    awaiting_reassignment: "要求重新指派",
    rejected: "拒絕任務",
    reassigned: "重新指派",
    completed: "標記完成",
    approved: "批准完成",
    cancelled: "取消任務",
  };
  return labels[state] ?? taskStateLabel(state);
}

export function formatTaskDate(value: string): string {
  return new Intl.DateTimeFormat("zh-HK", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Hong_Kong",
  }).format(new Date(value));
}
