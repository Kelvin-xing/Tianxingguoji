"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Icon } from "@/components/workspace/Icon";
import { getWorkspaceAccessSnapshot } from "@/modules/access/client";
import {
  classifyTaskFailure,
  listTasks,
  type TaskListResult,
} from "@/modules/tasks/client";
import { TASK_STATES, type TaskState } from "@/modules/tasks/public";
import {
  TaskAudienceNotice,
  TaskListItem,
  TaskPageState,
  taskStateLabel,
} from "./task-ui";

type LoadState = "loading" | "ready" | "unauthenticated" | "denied" | "unavailable";
type TaskFilter = "all" | TaskState;

export function TasksDirectory() {
  const mounted = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [result, setResult] = useState<TaskListResult | null>(null);
  const [filter, setFilter] = useState<TaskFilter>("all");

  const load = useCallback(async () => {
    controller.current?.abort();
    const nextController = new AbortController();
    controller.current = nextController;
    setState("loading");
    try {
      const [tasks, access] = await Promise.all([
        listTasks(undefined, nextController.signal),
        getWorkspaceAccessSnapshot(nextController.signal),
      ]);
      if (!mounted.current || nextController.signal.aborted) return;
      if (!access.capabilities.some((capability) => String(capability) === "tasks.read")) {
        setResult(null);
        setState("denied");
        return;
      }
      setResult(tasks);
      setState("ready");
    } catch (error) {
      if (!mounted.current || nextController.signal.aborted) return;
      const failure = classifyTaskFailure(error);
      setResult(null);
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

  const tasks = result?.tasks.filter((task) => filter === "all" || task.state === filter) ?? [];

  return (
    <div className="max-w-[1100px] mx-auto space-y-6">
      <header className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
        <div>
          <div className="eyebrow">案件工作</div>
          <h2 className="page-title">任務</h2>
          <p className="page-subtitle">查看目前可處理的案件任務和到期時間。</p>
        </div>
        <label className="select-field self-start sm:self-auto">
          <Icon name="filter" size={15} />
          <span className="sr-only">篩選任務狀態</span>
          <select aria-label="篩選任務狀態" value={filter} disabled={state === "loading"} onChange={(event) => setFilter(event.target.value as TaskFilter)}>
            <option value="all">全部狀態</option>
            {TASK_STATES.map((taskState) => <option value={taskState} key={taskState}>{taskStateLabel(taskState)}</option>)}
          </select>
        </label>
      </header>

      {result ? <TaskAudienceNotice audience={result.audience} /> : null}

      <section aria-labelledby="task-list-heading" aria-busy={state === "loading"}>
        <div className="pb-3 border-b" style={{ borderColor: "var(--border)" }}>
          <h3 id="task-list-heading" className="section-title">工作清單</h3>
          <p className="section-detail">顯示 {tasks.length} 項目前篩選結果。</p>
        </div>
        {state === "loading" ? <TaskPageState title="正在載入任務" detail="請稍候。" /> : null}
        {state === "unauthenticated" ? <TaskPageState title="工作階段已失效" detail="請重新登入後查看任務。" login /> : null}
        {state === "denied" ? <TaskPageState title="無法查看任務" detail="目前帳號沒有查看任務的權限。" /> : null}
        {state === "unavailable" ? <TaskPageState title="任務服務暫時不可用" detail="請稍後重試。" onRetry={() => void load()} /> : null}
        {state === "ready" && tasks.length === 0 ? <TaskPageState title="目前沒有任務" detail="此篩選條件下沒有可顯示的任務。" /> : null}
        {state === "ready" && tasks.length > 0 ? <ul>{tasks.map((task) => <TaskListItem key={task.id} task={task} />)}</ul> : null}
      </section>
    </div>
  );
}
