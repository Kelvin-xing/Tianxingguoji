import "server-only";

import { loadRuntimeEnvironment } from "../../../lib/runtime/runtime-environment.ts";
import { getApplicationTenantRunner } from "../../shared/server.ts";
import { TaskWorkspaceService } from "../application/workspace-service.ts";
import { PostgresqlTaskWorkspaceRepository } from "./postgresql-workspace-repository.ts";
import { P3TaskService } from "../application/p3-service.ts";
import { PostgresqlP3TaskRepository } from "./p3-postgresql-repository.ts";
import { PostgresqlCasesTaskFactsPort } from "../../cases/server.ts";
import { PostgresqlAccessTaskFactsPort } from "../../access/server.ts";
import { PostgresqlCleanTaskEvidencePort } from "../../documents/server.ts";
import { ApplicationTaskRequestConsumer } from "../application/application-task-request-consumer.ts";
import { PostgresqlCasesApplicationTaskRequestFactsPort } from "../../cases/server.ts";
import { ApplicationSubmissionConsumer } from "../../cases/server.ts";
import { PostgresqlTasksApplicationCompletionEventFactsPort } from "./postgresql-application-completion-event-facts.ts";

export interface TaskWorkflowRuntime {
  readonly service: TaskWorkspaceService;
  readonly p3Service: P3TaskService;
  readonly applicationTaskConsumer: ApplicationTaskRequestConsumer;
  readonly applicationSubmissionConsumer: ApplicationSubmissionConsumer;
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
      const runner = getApplicationTenantRunner();
      runtime = Object.freeze({ service: new TaskWorkspaceService(
        new PostgresqlTaskWorkspaceRepository(runner),
      ), p3Service: new P3TaskService(new PostgresqlP3TaskRepository(
        runner, new PostgresqlCasesTaskFactsPort(), new PostgresqlAccessTaskFactsPort(),
        new PostgresqlCleanTaskEvidencePort(),
      )), applicationTaskConsumer: new ApplicationTaskRequestConsumer(
        runner,new PostgresqlCasesApplicationTaskRequestFactsPort(),
      ), applicationSubmissionConsumer: new ApplicationSubmissionConsumer(
        runner,new PostgresqlTasksApplicationCompletionEventFactsPort(),
        new PostgresqlCleanTaskEvidencePort(),
      ) });
    } catch { throw new TaskWorkflowRuntimeUnavailable(); }
    runtimes.set(mode, runtime);
  }
  return runtime;
}
