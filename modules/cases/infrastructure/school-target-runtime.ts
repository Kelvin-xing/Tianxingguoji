import "server-only";

import { loadRuntimeEnvironment } from "../../../lib/runtime/runtime-environment.ts";
import { PostgresqlResolvedSchoolTransaction } from "../../schools/server.ts";
import { getApplicationTenantRunner } from "../../shared/server.ts";
import { SchoolTargetService } from "../application/school-target-service.ts";
import { createPostgreSqlAdapter } from "./postgresql.ts";
import { PostgresqlSchoolTargetRepository } from "./postgresql-school-target-repository.ts";

export interface SchoolTargetRuntime {
  readonly service: Pick<SchoolTargetService, "getSchoolTargets">;
}

export class SchoolTargetRuntimeUnavailable extends Error {
  constructor() {
    super("School target runtime is not configured.");
    this.name = "SchoolTargetRuntimeUnavailable";
  }
}

const globalForSchoolTarget = globalThis as typeof globalThis & {
  __txSchoolTargetRuntimes?: Map<string, SchoolTargetRuntime>;
};

export function getSchoolTargetRuntime(): SchoolTargetRuntime {
  const mode = loadRuntimeEnvironment().appRuntimeMode;
  if (mode === "production-aws") throw new SchoolTargetRuntimeUnavailable();
  const runtimes = globalForSchoolTarget.__txSchoolTargetRuntimes ??
    new Map<string, SchoolTargetRuntime>();
  globalForSchoolTarget.__txSchoolTargetRuntimes = runtimes;
  let runtime = runtimes.get(mode);
  if (!runtime) {
    const adapter = createPostgreSqlAdapter(getApplicationTenantRunner());
    const schools = new PostgresqlResolvedSchoolTransaction();
    const service = new SchoolTargetService({
      repository: new PostgresqlSchoolTargetRepository(adapter, schools),
    });
    runtime = Object.freeze({
      service: Object.freeze({
        getSchoolTargets: service.getSchoolTargets.bind(service),
      }),
    });
    runtimes.set(mode, runtime);
  }
  return runtime;
}
