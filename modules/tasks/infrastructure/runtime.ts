import "server-only";

import { loadRuntimeEnvironment } from "../../../lib/runtime/runtime-environment.ts";
import { getApplicationTenantRunner } from "../../shared/server.ts";
import { TaskWorkspaceService } from "../application/workspace-service.ts";
import { PostgresqlTaskWorkspaceRepository } from "./postgresql-workspace-repository.ts";

export interface TaskWorkflowRuntime {
  readonly service: TaskWorkspaceService;
}

export function isTaskWorkflowRuntimeUnavailable(value: unknown): value is TaskWorkflowRuntimeUnavailable {
  return value instanceof Error && value.name === "TaskWorkflowRuntimeUnavailable";
}

const globalForTasks = globalThis as typeof globalThis & {
  __txTaskWorkflowRuntimes?: Map<string, TaskWorkflowRuntime>;
};

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
  const mode = loadRuntimeEnvironment().appRuntimeMode;
  if (mode === "production-aws") throw new TaskWorkflowRuntimeUnavailable();
  const runtimes = globalForTasks.__txTaskWorkflowRuntimes ?? new Map<string, TaskWorkflowRuntime>();
  globalForTasks.__txTaskWorkflowRuntimes = runtimes;
  let runtime = runtimes.get(mode);
  if (!runtime) {
    try {
      runtime = Object.freeze({ service: new TaskWorkspaceService(
        new PostgresqlTaskWorkspaceRepository(getApplicationTenantRunner()),
      ) });
    } catch { throw new TaskWorkflowRuntimeUnavailable(); }
    runtimes.set(mode, runtime);
  }
  return runtime;
}
