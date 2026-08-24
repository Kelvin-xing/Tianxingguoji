import "server-only";

import { AssessmentService } from "../application/assessment-service.ts";
import type { CaseService } from "../application/service.ts";
import { CaseWorkspaceService } from "../application/workspace-service.ts";
import { CaseWorkflowService } from "../application/workflow-service.ts";
import { CaseReferralSourceAssignmentService } from "../application/referral-source-assignment-service.ts";
import { loadRuntimeEnvironment } from "../../../lib/runtime/runtime-environment.ts";
import { getApplicationTenantRunner } from "../../shared/server.ts";
import { createPostgreSqlAdapter } from "./postgresql.ts";
import { PostgresqlCaseWorkspaceRepository } from "./postgresql-workspace-repository.ts";
import { PostgresqlCaseWorkflowRepository } from "./postgresql-workflow-repository.ts";
import { PostgresqlAssessmentRepository } from "./postgresql-assessment-repository.ts";
import { PostgresqlCaseReferralSourceAssignmentRepository } from "./postgresql-referral-source-assignment-repository.ts";

export interface CaseReferralSourceRuntime { readonly service: CaseReferralSourceAssignmentService }
export class CaseReferralSourceRuntimeUnavailable extends Error {
  constructor() { super("Case referral source runtime is not configured."); this.name = "CaseReferralSourceRuntimeUnavailable"; }
}
export function isCaseReferralSourceRuntimeUnavailable(value: unknown): value is CaseReferralSourceRuntimeUnavailable {
  return value instanceof Error && value.name === "CaseReferralSourceRuntimeUnavailable";
}
const globalForCaseReferralSource = globalThis as typeof globalThis & {
  __txCaseReferralSourceRuntimes?: Map<string, CaseReferralSourceRuntime>;
};
export function getCaseReferralSourceRuntime(): CaseReferralSourceRuntime {
  const mode = loadRuntimeEnvironment().appRuntimeMode;
  if (mode === "production-aws") throw new CaseReferralSourceRuntimeUnavailable();
  const runtimes = globalForCaseReferralSource.__txCaseReferralSourceRuntimes ??
    new Map<string, CaseReferralSourceRuntime>();
  globalForCaseReferralSource.__txCaseReferralSourceRuntimes = runtimes;
  let runtime = runtimes.get(mode);
  if (!runtime) {
    try { runtime = Object.freeze({ service: new CaseReferralSourceAssignmentService(
      new PostgresqlCaseReferralSourceAssignmentRepository(getApplicationTenantRunner())) }); }
    catch { throw new CaseReferralSourceRuntimeUnavailable(); }
    runtimes.set(mode, runtime);
  }
  return runtime;
}

export interface CaseRuntime {
  readonly service: CaseService;
  readonly assessmentService: AssessmentService;
}

export class CaseRuntimeUnavailable extends Error {
  constructor() {
    super("Case runtime is not configured.");
    this.name = "CaseRuntimeUnavailable";
  }
}

export function isCaseRuntimeUnavailable(error: unknown): error is CaseRuntimeUnavailable {
  return error instanceof Error && error.name === "CaseRuntimeUnavailable";
}

/**
 * The production composition root is installed with the approved HK RDS
 * adapter only. There is no local or legacy-Neon fallback for case writes.
 */
export function getCaseRuntime(): CaseRuntime {
  throw new CaseRuntimeUnavailable();
}

export interface CaseWorkspaceRuntime {
  readonly service: CaseWorkspaceService;
  readonly assessmentService: AssessmentService;
  readonly workflowService: CaseWorkflowService;
}

const globalForCaseWorkspace = globalThis as typeof globalThis & {
  __txCaseWorkspaceRuntimes?: Map<string, CaseWorkspaceRuntime>;
};

export function getCaseWorkspaceRuntime(): CaseWorkspaceRuntime {
  const mode = loadRuntimeEnvironment().appRuntimeMode;
  if (mode === "production-aws") throw new CaseRuntimeUnavailable();
  const runtimes = globalForCaseWorkspace.__txCaseWorkspaceRuntimes ??
    new Map<string, CaseWorkspaceRuntime>();
  globalForCaseWorkspace.__txCaseWorkspaceRuntimes = runtimes;
  let runtime = runtimes.get(mode);
  if (!runtime) {
    const adapter = createPostgreSqlAdapter(getApplicationTenantRunner());
    runtime = Object.freeze({
      service: new CaseWorkspaceService(new PostgresqlCaseWorkspaceRepository(adapter)),
      assessmentService: new AssessmentService({
        repository: new PostgresqlAssessmentRepository(adapter),
      }),
      workflowService: new CaseWorkflowService(new PostgresqlCaseWorkflowRepository(adapter)),
    });
    runtimes.set(mode, runtime);
  }
  return runtime;
}
