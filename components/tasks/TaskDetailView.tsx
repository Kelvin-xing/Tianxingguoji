"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { Icon } from "@/components/workspace/Icon";
import { getWorkspaceAccessSnapshot } from "@/modules/access/client";
import {
  classifyTaskFailure,
  getTask,
  type TaskDetailResult,
} from "@/modules/tasks/client";
import { AutomaticTaskTransitionControls, type AutomaticTaskOutcome } from "./AutomaticTaskTransitionControls";
import { TaskTransitionControls } from "./TaskTransitionControls";
import { TaskAudienceNotice, TaskKindPill, TaskPageState, TaskStatePill, formatTaskDate } from "./task-ui";

type LoadState = "loading" | "ready" | "unauthenticated" | "denied" | "not_found" | "unavailable";

export function TaskDetailView({ taskId }: { readonly taskId: string }) {
  const mounted = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [result, setResult] = useState<TaskDetailResult | null>(null);
  const [canTransition, setCanTransition] = useState(false);
  const [actorUserId, setActorUserId] = useState<string | null>(null);
  const [transitionOutcome, setTransitionOutcome] = useState<"manual" | AutomaticTaskOutcome | null>(null);

  const load = useCallback(async () => {
    controller.current?.abort();
    const nextController = new AbortController();
    controller.current = nextController;
    setState("loading");
    setTransitionOutcome(null);
    try {
      const [task, access] = await Promise.all([
        getTask(taskId, nextController.signal),
        getWorkspaceAccessSnapshot(nextController.signal),
      ]);
      if (!mounted.current || nextController.signal.aborted) return;
      if (!access.capabilities.some((capability) => String(capability) === "tasks.read")) {
        setResult(null);
        setCanTransition(false);
        setActorUserId(null);
        setState("denied");
        return;
      }
      setResult(task);
      setActorUserId(access.user_id);
      setCanTransition(access.capabilities.some((capability) => String(capability) === "tasks.transition"));
      setState("ready");
    } catch (error) {
      if (!mounted.current || nextController.signal.aborted) return;
      const failure = classifyTaskFailure(error);
      setResult(null);
      setCanTransition(false);
      setActorUserId(null);
      setState(failure === "unauthenticated" ? "unauthenticated" : failure === "forbidden" ? "denied" : failure === "not_found" ? "not_found" : "unavailable");
    } finally {
      if (controller.current === nextController) controller.current = null;
    }
  }, [taskId]);

  useEffect(() => {
    mounted.current = true;
    queueMicrotask(() => { if (mounted.current) void load(); });
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, [load]);

  if (state !== "ready" || result === null) {
    const content = state === "loading" ? ["正在載入任務", "請稍候。"]
      : state === "unauthenticated" ? ["工作階段已失效", "請重新登入後查看任務。"]
        : state === "denied" ? ["無法查看任務", "目前帳號不能查看這項任務。"]
          : state === "not_found" ? ["找不到任務", "這項任務不存在或目前帳號不可查看。"]
            : ["任務服務暫時不可用", "請稍後重試。"];
    return <div className="max-w-3xl mx-auto"><TaskPageState title={content[0]} detail={content[1]} login={state === "unauthenticated"} onRetry={state === "unavailable" ? () => void load() : undefined} /></div>;
  }

  const task = result.task;
  const internal = result.audience === "case_workspace";
  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center gap-2 text-xs" style={{ color: "var(--text-muted)" }}>
        <Link href="/tasks" className="quiet-link">任務</Link><Icon name="chevron-right" size={14} /><span>任務詳情</span>
      </div>
      <TaskAudienceNotice audience={result.audience} />
      <header className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 border-b pb-5" style={{ borderColor: "var(--border)" }}>
        <div className="min-w-0">
          <div className="eyebrow">任務詳情</div>
          <h2 className="page-title break-words">{task.title}</h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <TaskKindPill kind={task.task_kind} />
          {task.is_overdue ? <span className="status-pill status-warning">已逾期</span> : null}
          <TaskStatePill state={task.state} />
        </div>
      </header>
      <section aria-labelledby="task-brief-heading" className="space-y-4">
        <div>
          <h3 id="task-brief-heading" className="section-title">工作內容</h3>
          <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6" style={{ color: "var(--text-secondary)" }}>{task.task_brief}</p>
        </div>
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-4 border-y py-4" style={{ borderColor: "var(--border)" }}>
          <Info label="到期時間" value={formatTaskDate(task.due_at)} />
          <Info label="最後更新" value={formatTaskDate(task.updated_at)} />
          <Info label="任務類型" value={task.task_kind === "application_prepare_submit" ? "準備並提交申請" : task.task_kind === "interview_support" ? "面試支援" : "手工任務"} />
          {task.current_assignment ? <Info label="目前指派" value={`${task.current_assignment.assignee_role === "advisor" ? "顧問" : "外部協作人員"} · ${task.current_assignment.status}`} /> : null}
          {internal ? <Info label="負責人" value={result.task.assignee.label} /> : null}
          {internal ? <div><dt className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>案件</dt><dd className="mt-1"><Link href={`/cases/${result.task.case_id}`} className="quiet-link">{result.task.case_number}</Link></dd></div> : null}
        </dl>
      </section>
      {transitionOutcome ? (
        <div className="inline-callout" role="status">
          <Icon name={transitionOutcome === "target_pending" ? "clock" : "check-circle"} size={15} />
          <span>{transitionOutcome === "target_pending"
            ? "Task 已完成，SchoolTarget 待自動恢復。"
            : transitionOutcome === "target_completed"
              ? "Task 已完成，學校申請狀態已同步更新。"
              : transitionOutcome === "stale"
                ? "任務已有較新版本，內容已重新載入。"
                : "任務已更新，內容已重新載入。"}</span>
        </div>
      ) : null}
      {canTransition && task.task_kind === "manual" && task.available_transitions.length > 0 ? (
        <TaskTransitionControls
          task={task}
          caseId={internal ? result.task.case_id : undefined}
          onAuthoritativeChange={(next, outcome) => {
            setResult(next);
            setTransitionOutcome(outcome === "success" ? "manual" : "stale");
            setCanTransition(true);
          }}
        />
      ) : null}
      {canTransition && task.task_kind !== "manual" && actorUserId !== null && (task.allowed_actions.length > 0) ? (
        <AutomaticTaskTransitionControls
          task={task}
          actorUserId={actorUserId}
          onAuthoritativeChange={(next, outcome) => {
            setResult(next);
            setTransitionOutcome(outcome);
            setCanTransition(true);
          }}
        />
      ) : null}
    </div>
  );
}

function Info({ label, value }: { readonly label: string; readonly value: string }) {
  return <div><dt className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>{label}</dt><dd className="mt-1 break-words text-sm" style={{ color: "var(--text-primary)" }}>{value}</dd></div>;
}
