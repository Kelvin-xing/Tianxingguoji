import type { TaskWorkflowService } from "./service.ts";

export interface TaskWorkflowRuntime {
  readonly service: TaskWorkflowService;
}

export class TaskWorkflowRuntimeUnavailable extends Error {
  constructor() {
    super("Task workflow runtime is not configured.");
    this.name = "TaskWorkflowRuntimeUnavailable";
  }
}

/**
 * Release 1 task writes require the approved HK RDS transaction adapter.
 * There is deliberately no local, JSON, mock, or legacy-Neon fallback.
 */
export function getTaskWorkflowRuntime(): TaskWorkflowRuntime {
  throw new TaskWorkflowRuntimeUnavailable();
}
