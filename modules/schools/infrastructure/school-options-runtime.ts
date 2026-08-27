import "server-only";

import { loadRuntimeEnvironment } from "../../../lib/runtime/runtime-environment.ts";
import { getApplicationTenantRunner } from "../../shared/server.ts";
import { SchoolOptionsService } from "../application/school-options-service.ts";
import { PostgresqlSchoolOptionsRepository } from "./postgresql-school-options-repository.ts";

export interface SchoolOptionsRuntime { readonly service: SchoolOptionsService }
export class SchoolOptionsRuntimeUnavailable extends Error {
  constructor() { super("School options runtime is not configured."); this.name = "SchoolOptionsRuntimeUnavailable"; }
}

const globalForSchoolOptions = globalThis as typeof globalThis & {
  __txSchoolOptionsRuntimes?: Map<string, SchoolOptionsRuntime>;
};

export function getSchoolOptionsRuntime(): SchoolOptionsRuntime {
  const mode = loadRuntimeEnvironment().appRuntimeMode;
  if (mode === "production-aws") throw new SchoolOptionsRuntimeUnavailable();
  const runtimes = globalForSchoolOptions.__txSchoolOptionsRuntimes ?? new Map<string, SchoolOptionsRuntime>();
  globalForSchoolOptions.__txSchoolOptionsRuntimes = runtimes;
  let runtime = runtimes.get(mode);
  if (!runtime) {
    runtime = Object.freeze({
      service: new SchoolOptionsService(new PostgresqlSchoolOptionsRepository(
        getApplicationTenantRunner(),
      )),
    });
    runtimes.set(mode,runtime);
  }
  return runtime;
}
