import "server-only";

import { isLocalSyntheticMode } from "../../../lib/runtime/local-synthetic-config.ts";
import { PostgresqlResolvedSchoolTransaction } from "../../schools/server.ts";
import { getLocalApplicationTenantRunner } from "../../shared/server.ts";
import { SchoolTargetService } from "../application/school-target-service.ts";
import { createPostgreSqlAdapter } from "./postgresql.ts";
import { PostgresqlSchoolTargetRepository } from "./postgresql-school-target-repository.ts";

export interface SchoolTargetRuntime {
  readonly service: SchoolTargetService;
}

export class SchoolTargetRuntimeUnavailable extends Error {
  constructor() {
    super("School target runtime is not configured.");
    this.name = "SchoolTargetRuntimeUnavailable";
  }
}

const globalForSchoolTarget = globalThis as typeof globalThis & {
  __txLocalSchoolTargetRuntime?: SchoolTargetRuntime;
};

export function getSchoolTargetRuntime(): SchoolTargetRuntime {
  if (!isLocalSyntheticMode()) throw new SchoolTargetRuntimeUnavailable();
  if (!globalForSchoolTarget.__txLocalSchoolTargetRuntime) {
    const adapter = createPostgreSqlAdapter(getLocalApplicationTenantRunner());
    const schools = new PostgresqlResolvedSchoolTransaction();
    globalForSchoolTarget.__txLocalSchoolTargetRuntime = Object.freeze({
      service: new SchoolTargetService({
        repository: new PostgresqlSchoolTargetRepository(adapter, schools),
      }),
    });
  }
  return globalForSchoolTarget.__txLocalSchoolTargetRuntime;
}
