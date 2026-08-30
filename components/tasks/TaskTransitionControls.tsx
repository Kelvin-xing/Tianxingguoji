"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

import { Icon } from "@/components/workspace/Icon";
import {
  TaskIdempotencyAttempt,
  classifyTaskFailure,
  getTask,
  getTaskAssigneeOptions,
  transitionTask,
  transitionTaskFingerprint,
  type AssignedTask,
  type CaseWorkspaceTask,
  type TaskAssignee,
  type TaskDetailResult,
} from "@/modules/tasks/client";
import type { TaskState } from "@/modules/tasks/public";
import { transitionLabel } from "./task-ui";

type TaskItem = CaseWorkspaceTask | AssignedTask;
type Notice = "validation" | "stale" | "conflict" | "denied" | "unavailable" | null;
type AuthoritativeOutcome = "success" | "stale";

export function TaskTransitionControls({
  task,
  caseId,
  onAuthoritativeChange,
  onAssignmentEnded,
}: {
  readonly task: TaskItem;
  readonly caseId?: string;
  readonly onAuthoritativeChange: (result: TaskDetailResult, outcome: AuthoritativeOutcome) => void;
  readonly onAssignmentEnded: () => void;
}) {
  const submitting = useRef(false);
  const attempt = useRef<TaskIdempotencyAttempt | null>(null);
  const actionSelect = useRef<HTMLSelectElement | null>(null);
  if (attempt.current === null) attempt.current = new TaskIdempotencyAttempt();

  const [selectedTo, setSelectedTo] = useState<TaskState | "">("");
  const [reason, setReason] = useState("");
  const [nextAssigneeId, setNextAssigneeId] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [assignees, setAssignees] = useState<readonly TaskAssignee[]>([]);
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const selected = task.available_transitions.find((transition) => transition.to === selectedTo) ?? null;

  useEffect(() => {
    if (!selected?.requires_assignee || !caseId) {
      queueMicrotask(() => {
        setAssignees([]);
        setOptionsLoading(false);
      });
      return;
    }
    const controller = new AbortController();
    queueMicrotask(() => setOptionsLoading(true));
    getTaskAssigneeOptions(caseId, controller.signal)
      .then((result) => setAssignees(result.assignees))
      .catch(() => {
        setAssignees([]);
        setNotice("unavailable");
      })
      .finally(() => setOptionsLoading(false));
    return () => controller.abort();
  }, [caseId, selected?.requires_assignee]);

  function commandChanged() {
    attempt.current!.rotate();
    setNotice(null);
    setConfirmed(false);
  }

  function resetForm(nextNotice: Notice) {
    setSelectedTo("");
    setReason("");
    setNextAssigneeId("");
    setConfirmed(false);
    setNotice(nextNotice);
    queueMicrotask(() => actionSelect.current?.focus());
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || pending || selected === null) return;
    if (!confirmed || (selected.requires_reason && reason.trim() === "") || (selected.requires_assignee && nextAssigneeId === "")) {
      setNotice("validation");
      return;
    }
    const input = {
      to: selected.to,
      expected_record_version: task.record_version,
      reason: reason.trim(),
      next_assignee_user_id: selected.requires_assignee ? nextAssigneeId : null,
    } as const;
    submitting.current = true;
    setPending(true);
    setNotice(null);
    try {
      const receipt = await transitionTask(
        task.id,
        input,
        attempt.current!.keyFor(transitionTaskFingerprint(task.id, input)),
      );
      let authoritative: TaskDetailResult;
      try {
        authoritative = await getTask(task.id);
      } catch (error) {
        const assignmentEnded = caseId === undefined &&
          (input.to === "completed" || input.to === "awaiting_reassignment") &&
          classifyTaskFailure(error) === "not_found";
        if (!assignmentEnded) throw error;
        attempt.current!.complete();
        resetForm(null);
        onAssignmentEnded();
        return;
      }
      if (authoritative.task.id !== receipt.id || authoritative.task.record_version !== receipt.record_version) {
        throw new TypeError("Task authority mismatch.");
      }
      attempt.current!.complete();
      resetForm(null);
      onAuthoritativeChange(authoritative, "success");
    } catch (error) {
      const failure = classifyTaskFailure(error);
      if (failure === "stale") {
        attempt.current!.rotate();
        try {
          const authoritative = await getTask(task.id);
          resetForm("stale");
          onAuthoritativeChange(authoritative, "stale");
        } catch {
          setNotice("unavailable");
        }
      } else {
        if (failure !== "unavailable") attempt.current!.rotate();
        setNotice(
          failure === "validation" ? "validation"
            : failure === "conflict" ? "conflict"
              : failure === "forbidden" || failure === "unauthenticated" || failure === "not_found" ? "denied"
                : "unavailable",
        );
      }
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  return (
    <section className="workspace-section space-y-4" aria-labelledby="task-transition-heading">
      <div>
        <h3 id="task-transition-heading" className="section-title">更新任務</h3>
        <p className="section-detail">可用操作會按目前任務和帳戶權限更新。</p>
      </div>
      <form onSubmit={submit} className="space-y-4" aria-busy={pending}>
        <label className="field-label" htmlFor={`task-transition-${task.id}`}>
          操作
          <select
            ref={actionSelect}
            id={`task-transition-${task.id}`}
            value={selectedTo}
            disabled={pending}
            required
            onChange={(event) => {
              commandChanged();
              setSelectedTo(event.target.value as TaskState | "");
              setReason("");
              setNextAssigneeId("");
            }}
          >
            <option value="">選擇操作</option>
            {task.available_transitions.map((transition) => <option value={transition.to} key={transition.to}>{transitionLabel(transition.to)}</option>)}
          </select>
        </label>

        {selected?.requires_assignee ? (
          <label className="field-label" htmlFor={`task-assignee-${task.id}`}>
            新的負責人
            <select
              id={`task-assignee-${task.id}`}
              value={nextAssigneeId}
              disabled={pending || optionsLoading}
              required
              onChange={(event) => { commandChanged(); setNextAssigneeId(event.target.value); }}
            >
              <option value="">{optionsLoading ? "正在載入負責人" : "選擇負責人"}</option>
              {assignees.map((assignee) => <option value={assignee.id} key={assignee.id}>{assignee.label} · {assignee.role === "advisor" ? "顧問" : "外部協作人員"}</option>)}
            </select>
          </label>
        ) : null}

        {selected ? (
          <label className="field-label" htmlFor={`task-reason-${task.id}`}>
            原因{selected.requires_reason ? <span aria-hidden="true"> *</span> : null}
            <textarea
              id={`task-reason-${task.id}`}
              value={reason}
              maxLength={4_000}
              rows={3}
              required={selected.requires_reason}
              disabled={pending}
              onChange={(event) => { commandChanged(); setReason(event.target.value); }}
            />
          </label>
        ) : null}

        {selected ? (
          <label className="flex items-start gap-3 text-sm">
            <input type="checkbox" checked={confirmed} disabled={pending} onChange={(event) => { attempt.current!.rotate(); setNotice(null); setConfirmed(event.target.checked); }} />
            <span>我確認執行「{transitionLabel(selected.to)}」，並保留任務的既有處理紀錄。</span>
          </label>
        ) : null}

        <TransitionNotice notice={notice} />
        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
          <button type="button" className="secondary-button justify-center" disabled={pending} onClick={() => { attempt.current!.complete(); resetForm(null); }}>取消</button>
          <button type="submit" className="primary-button justify-center min-w-36" disabled={pending || selected === null} aria-busy={pending}>
            <Icon name={pending ? "clock" : "check"} size={15} />{pending ? "正在更新" : "確認更新"}
          </button>
        </div>
      </form>
    </section>
  );
}

function TransitionNotice({ notice }: { readonly notice: Notice }) {
  if (notice === null) return null;
  const message = notice === "validation" ? "請完整選擇操作、所需負責人及原因，並確認本次操作。"
      : notice === "stale" ? "任務已有較新版本，已重新載入最新內容。"
        : notice === "conflict" ? "目前狀態不接受這項操作，請重新確認。"
          : notice === "denied" ? "目前帳號不能執行這項任務操作。"
            : "結果暫時無法確認，請稍後重試；重試不會重複更新。";
  return <div className="form-error" role="alert"><Icon name="x" size={15} /><span>{message}</span></div>;
}
