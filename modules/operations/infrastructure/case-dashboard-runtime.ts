import "server-only";

import { loadRuntimeEnvironment } from "../../../lib/runtime/runtime-environment.ts";
import { getApplicationTenantRunner } from "../../shared/server.ts";
import type { CaseDashboardProjectionService } from "../domain/case-dashboard-projection.ts";
import { CaseDashboardProjectionService as DashboardService } from "../domain/case-dashboard-projection.ts";
import { PostgresqlCaseDashboardProjectionRepository } from "./postgresql-case-dashboard-repository.ts";

export interface CaseDashboardRuntime {
  readonly service: CaseDashboardProjectionService;
}

export class CaseDashboardRuntimeUnavailable extends Error {
  constructor() {
    super("Case dashboard HK RDS runtime is not configured.");
    this.name = "CaseDashboardRuntimeUnavailable";
  }
}

const globalForCaseDashboard = globalThis as typeof globalThis & {
  __txCaseDashboardRuntimes?: Map<string, CaseDashboardRuntime>;
};

/** Local/test adapters are enabled explicitly; production AWS remains fail-closed. */
export function getCaseDashboardRuntime(): CaseDashboardRuntime {
  let mode: string;
  try {
    mode = loadRuntimeEnvironment().appRuntimeMode;
  } catch {
    throw new CaseDashboardRuntimeUnavailable();
  }
  if (mode === "production-aws") throw new CaseDashboardRuntimeUnavailable();

  const runtimes = globalForCaseDashboard.__txCaseDashboardRuntimes ??
    new Map<string, CaseDashboardRuntime>();
  globalForCaseDashboard.__txCaseDashboardRuntimes = runtimes;
  const existing = runtimes.get(mode);
  if (existing) return existing;

  const runtime = Object.freeze({
    service: new DashboardService({
      repository: new PostgresqlCaseDashboardProjectionRepository(getApplicationTenantRunner()),
    }),
  });
  runtimes.set(mode, runtime);
  return runtime;
}
