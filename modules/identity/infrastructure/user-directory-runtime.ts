import "server-only";

import { loadRuntimeEnvironment } from "../../../lib/runtime/runtime-environment.ts";
import { getApplicationTenantRunner } from "../../shared/server.ts";
import { UserDirectoryService } from "../application/user-directory.ts";
import { PostgresqlUserDirectoryRepository } from "./postgresql-user-directory-repository.ts";

export interface UserDirectoryRuntime {
  readonly service: UserDirectoryService;
}

export class UserDirectoryRuntimeUnavailable extends Error {
  constructor() {
    super("User directory runtime is not configured.");
    this.name = "UserDirectoryRuntimeUnavailable";
  }
}

export function isUserDirectoryRuntimeUnavailable(
  error: unknown,
): error is UserDirectoryRuntimeUnavailable {
  return error instanceof UserDirectoryRuntimeUnavailable;
}

const globalForUserDirectory = globalThis as typeof globalThis & {
  __txUserDirectoryRuntimes?: Map<string, UserDirectoryRuntime>;
};

export function getUserDirectoryRuntime(): UserDirectoryRuntime {
  const mode = loadRuntimeEnvironment().appRuntimeMode;
  if (mode === "production-aws") throw new UserDirectoryRuntimeUnavailable();

  const runtimes = globalForUserDirectory.__txUserDirectoryRuntimes ??
    new Map<string, UserDirectoryRuntime>();
  globalForUserDirectory.__txUserDirectoryRuntimes = runtimes;
  let runtime = runtimes.get(mode);
  if (!runtime) {
    try {
      runtime = Object.freeze({
        service: new UserDirectoryService(
          new PostgresqlUserDirectoryRepository(getApplicationTenantRunner()),
        ),
      });
    } catch {
      throw new UserDirectoryRuntimeUnavailable();
    }
    runtimes.set(mode, runtime);
  }
  return runtime;
}
