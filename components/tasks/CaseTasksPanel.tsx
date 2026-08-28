"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import { Icon } from "@/components/workspace/Icon";
import { useCaseWorkflowContext } from "@/components/cases/CaseWorkflowContext";
import { getWorkspaceAccessSnapshot } from "@/modules/access/client";
import {
  TaskIdempotencyAttempt,
  classifyTaskFailure,
  createTask,
  createTaskFingerprint,
  getTaskAssigneeOptions,
  listTasks,
  type CaseWorkspaceTask,
  type TaskAssignee,
} from "@/modules/tasks/client";
import { TaskListItem, TaskPageState } from "./task-ui";

type LoadState = "loading" | "ready" | "unauthenticated" | "denied" | "unavailable";
type OptionsState = "idle" | "loading" | "ready" | "unavailable";
type Notice = "success" | "validation" | "conflict" | "denied" | "unavailable" | null;

export function CaseTasksPanel({ caseId }: { readonly caseId: string }) {
  const { workflowStatus } = useCaseWorkflowContext();
  const mounted = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const submitting = useRef(false);
  const attempt = useRef<TaskIdempotencyAttempt | null>(null);
  const titleInput = useRef<HTMLInputElement | null>(null);
  if (attempt.current === null) attempt.current = new TaskIdempotencyAttempt();

  const [state, setState] = useState<LoadState>("loading");
  const [tasks, setTasks] = useState<readonly CaseWorkspaceTask[]>([]);
  const [canCreate, setCanCreate] = useState(false);
  const [optionsState, setOptionsState] = useState<OptionsState>("idle");
  const [assignees, setAssignees] = useState<readonly TaskAssignee[]>([]);
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [dueLocal, setDueLocal] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const load = useCallback(async () => {
    controller.current?.abort();
    const nextController = new AbortController();
    controller.current = nextController;
    setState("loading");
    setOptionsState("idle");
    try {
      const [taskResult, access] = await Promise.all([
        listTasks(caseId, nextController.signal),
        getWorkspaceAccessSnapshot(nextController.signal),
      ]);
      if (!mounted.current || nextController.signal.aborted) return;
      if (!access.capabilities.some((capability) => String(capability) === "tasks.read")) {
        setTasks([]);
        setCanCreate(false);
        setState("denied");
        return;
      }
      if (taskResult.audience !== "case_workspace") throw new TypeError("Invalid Case task audience.");
      setTasks(taskResult.tasks);
      const createAllowed = workflowStatus === "active" &&
        access.capabilities.some((capability) => String(capability) === "tasks.create");
      setCanCreate(createAllowed);
      setState("ready");
      if (createAllowed) {
        setOptionsState("loading");
        try {
          const options = await getTaskAssigneeOptions(caseId, nextController.signal);
          if (!mounted.current || nextController.signal.aborted) return;
          setAssignees(options.assignees);
          setOptionsState("ready");
        } catch {
          if (!mounted.current || nextController.signal.aborted) return;
          setAssignees([]);
          setOptionsState("unavailable");
        }
      }
    } catch (error) {
      if (!mounted.current || nextController.signal.aborted) return;
      const failure = classifyTaskFailure(error);
      setTasks([]);
      setCanCreate(false);
      setAssignees([]);
      setState(failure === "unauthenticated" ? "unauthenticated" : failure === "forbidden" || failure === "not_found" ? "denied" : "unavailable");
    } finally {
      if (controller.current === nextController) controller.current = null;
    }
  }, [caseId, workflowStatus]);

  useEffect(() => {
    mounted.current = true;
    queueMicrotask(() => { if (mounted.current) void load(); });
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, [load]);

  function draftChanged() {
    attempt.current!.rotate();
    setNotice(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || pending || !canCreate || optionsState !== "ready") return;
    const dueAt = hongKongLocalToIso(dueLocal);
    if (title.trim().length < 1 || title.trim().length > 300 || brief.trim().length < 1 || brief.trim().length > 4_000 || dueAt === null || assigneeId === "") {
      setNotice("validation");
      return;
    }
    const input = {
      case_id: caseId,
      title: title.trim(),
      task_brief: brief.trim(),
      due_at: dueAt,
      assignee_user_id: assigneeId,
    } as const;
    submitting.current = true;
    setPending(true);
    setNotice(null);
    try {
      const receipt = await createTask(input, attempt.current!.keyFor(createTaskFingerprint(input)));
      const authoritative = await listTasks(caseId);
      if (authoritative.audience !== "case_workspace") throw new TypeError("Invalid Case task audience.");
      const created = authoritative.tasks.find((task) => task.id === receipt.id);
      if (!created || created.record_version !== receipt.record_version) throw new TypeError("Task authority mismatch.");
      if (!mounted.current) return;
      attempt.current!.complete();
      setTasks(authoritative.tasks);
      setTitle("");
      setBrief("");
      setDueLocal("");
      setAssigneeId("");
      setNotice("success");
      queueMicrotask(() => titleInput.current?.focus());
    } catch (error) {
      if (!mounted.current) return;
      const failure = classifyTaskFailure(error);
      if (failure !== "unavailable") attempt.current!.rotate();
      setNotice(
        failure === "validation" ? "validation"
          : failure === "conflict" || failure === "stale" ? "conflict"
            : failure === "forbidden" || failure === "unauthenticated" || failure === "not_found" ? "denied"
              : "unavailable",
      );
    } finally {
      submitting.current = false;
      if (mounted.current) setPending(false);
    }
  }

  return (
    <section id="tasks" className="workspace-section space-y-5" aria-labelledby="case-tasks-heading" aria-busy={state === "loading"}>
      <div>
        <h3 id="case-tasks-heading" className="section-title">案件任務</h3>
        <p className="section-detail">集中查看本案的工作內容、負責人和到期時間。</p>
      </div>

      {state === "loading" ? <TaskPageState title="正在載入案件任務" detail="請稍候。" /> : null}
      {state === "unauthenticated" ? <TaskPageState title="工作階段已失效" detail="請重新登入後查看案件任務。" login /> : null}
      {state === "denied" ? <TaskPageState title="無法查看案件任務" detail="目前帳號不能查看本案任務。" /> : null}
      {state === "unavailable" ? <TaskPageState title="任務服務暫時不可用" detail="請稍後重試。" onRetry={() => void load()} /> : null}

      {state === "ready" && canCreate ? (
        <div className="border-y py-5 space-y-4" style={{ borderColor: "var(--border)" }}>
          <div><h4 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>新增任務</h4><p className="section-detail">負責人只能從目前可用名單中選擇；到期時間使用香港時間。</p></div>
          {optionsState === "unavailable" ? <div className="form-error" role="alert"><Icon name="x" size={15} /><span>暫時無法載入負責人選項，請重新載入後再試。</span></div> : null}
          <form className="grid grid-cols-1 md:grid-cols-2 gap-4" onSubmit={submit} aria-busy={pending}>
            <label className="field-label"><span>任務標題 *</span><input aria-label="任務標題" ref={titleInput} value={title} maxLength={300} required disabled={pending} onChange={(event) => { draftChanged(); setTitle(event.target.value); }} /></label>
            <label className="field-label"><span>負責人 *</span><select aria-label="負責人" value={assigneeId} required disabled={pending || optionsState !== "ready"} onChange={(event) => { draftChanged(); setAssigneeId(event.target.value); }}><option value="">{optionsState === "loading" ? "正在載入負責人" : "選擇負責人"}</option>{assignees.map((assignee) => <option value={assignee.id} key={assignee.id}>{assignee.label} · {assignee.role === "advisor" ? "顧問" : "外部協作人員"}</option>)}</select></label>
            <label className="field-label md:col-span-2"><span>工作內容 *</span><textarea aria-label="工作內容" value={brief} maxLength={4_000} rows={4} required disabled={pending} onChange={(event) => { draftChanged(); setBrief(event.target.value); }} /></label>
            <label className="field-label"><span>到期時間（香港時間）*</span><input aria-label="到期時間（香港時間）" type="datetime-local" value={dueLocal} required disabled={pending} onChange={(event) => { draftChanged(); setDueLocal(event.target.value); }} /></label>
            <div className="flex items-end justify-end"><button type="submit" className="primary-button justify-center min-w-32" disabled={pending || optionsState !== "ready"} aria-busy={pending}><Icon name={pending ? "clock" : "plus"} size={15} />{pending ? "正在建立" : "建立任務"}</button></div>
          </form>
          <CreateNotice notice={notice} />
        </div>
      ) : null}

      {state === "ready" && workflowStatus === "paused" ? (
        <div className="inline-callout" role="status"><Icon name="shield" size={15} /><span>案件暫停期間不能建立臨時任務；現有任務仍可查看。</span></div>
      ) : null}

      {state === "ready" && tasks.length === 0 ? <TaskPageState title="本案目前沒有任務" detail="建立後的任務會顯示在這裡。" /> : null}
      {state === "ready" && tasks.length > 0 ? <ul>{tasks.map((task) => <TaskListItem key={task.id} task={task} />)}</ul> : null}
    </section>
  );
}

function CreateNotice({ notice }: { readonly notice: Notice }) {
  if (notice === null) return null;
  const message = notice === "success" ? "任務已建立，案件任務已重新載入。"
    : notice === "validation" ? "請完整填寫標題、工作內容、到期時間和負責人。"
      : notice === "conflict" ? "本次建立與目前資料有衝突，請重新確認。"
        : notice === "denied" ? "目前帳號不能在本案建立任務。"
          : "結果暫時無法確認，請稍後重試；重試不會重複建立。";
  return <div className={notice === "success" ? "inline-callout" : "form-error"} role={notice === "success" ? "status" : "alert"}><Icon name={notice === "success" ? "check-circle" : "x"} size={15} /><span>{message}</span></div>;
}

function hongKongLocalToIso(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const date = new Date(`${value}:00+08:00`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
