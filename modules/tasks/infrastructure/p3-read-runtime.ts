import "server-only";

import { getApplicationTenantRunner } from "../../shared/server.ts";
import { P3TaskReadError, P3TaskReadService } from "../application/p3-read-service.ts";
import { PostgresqlP3TaskReadRepository } from "./postgresql-p3-read-repository.ts";

export interface P3TaskReadRuntime {
  readonly service: P3TaskReadService;
}

export function getP3TaskReadRuntime(): P3TaskReadRuntime {
  try {
    const runner = getApplicationTenantRunner();
    return Object.freeze({ service: new P3TaskReadService(new PostgresqlP3TaskReadRepository(runner)) });
  } catch {
    throw new P3TaskReadError("UNAVAILABLE");
  }
}
