import "server-only";

import type { PortalRepository } from "../application/repository-port.ts";
import { PortalService, type PortalServiceOptions } from "../application/service.ts";
import { getApplicationTenantRunner } from "../../shared/server.ts";
import { loadRuntimeEnvironment } from "../../../lib/runtime/runtime-environment.ts";
import { PostgreSqlPortalRepository } from "./postgresql-repository.ts";
import { PostgreSqlAccessPortalReadAdapter } from "../../access/server.ts";
import { PostgreSqlCasesPortalReadAdapter } from "../../cases/server.ts";
import { PostgreSqlCrmPortalReadAdapter } from "../../crm/server.ts";
import { PostgreSqlSchoolsPortalReadAdapter } from "../../schools/server.ts";
export { PortalRepositoryError } from "../application/repository-port.ts";
export { PostgreSqlPortalRepository } from "./postgresql-repository.ts";

export interface PortalRuntime {
  readonly repository: PortalRepository;
  readonly service: PortalService;
}

export class PortalRuntimeUnavailable extends Error {
  readonly code = "PORTAL_RUNTIME_UNAVAILABLE" as const;

  constructor() {
    super("External portal runtime is not configured.");
    this.name = "PortalRuntimeUnavailable";
  }
}

export function createPortalRuntime(repository: PortalRepository, service?: PortalService): PortalRuntime {
  if (!repository || typeof repository !== "object") {
    throw new PortalRuntimeUnavailable();
  }
  return Object.freeze({ repository, service: service ?? new PortalService({ repository, secretPepper: "test-only-portal-pepper-please-replace-32" }) });
}

export function getPortalRuntime(): PortalRuntime {
  try {
    const runtime = loadRuntimeEnvironment();
    if (runtime.appRuntimeMode === "production-aws") throw new PortalRuntimeUnavailable();
    const pepper = process.env.PORTAL_SECRET_PEPPER;
    if (!pepper || pepper.trim().length < 32) throw new PortalRuntimeUnavailable();
    const repository = new PostgreSqlPortalRepository({
      runner: getApplicationTenantRunner(),
      secretPepper: pepper,
      accessReadPort: new PostgreSqlAccessPortalReadAdapter(),
      casesReadPort: new PostgreSqlCasesPortalReadAdapter(),
      crmReadPort: new PostgreSqlCrmPortalReadAdapter(),
      schoolsReadPort: new PostgreSqlSchoolsPortalReadAdapter(),
    });
    const service = new PortalService({ repository, secretPepper: pepper });
    return createPortalRuntime(repository, service);
  } catch {
    throw new PortalRuntimeUnavailable();
  }
}
