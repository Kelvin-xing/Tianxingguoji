import "server-only";

import { loadRuntimeEnvironment } from "../../../lib/runtime/runtime-environment.ts";
import { getApplicationTenantRunner } from "../../shared/server.ts";
import { DuplicateReviewService } from "../application/duplicate-review-service.ts";
import { PostgresqlDuplicateReviewRepository } from "./postgresql-duplicate-review-repository.ts";

export interface DuplicateReviewRuntime {
  readonly service: DuplicateReviewService;
}

export class DuplicateReviewRuntimeUnavailable extends Error {
  constructor() {
    super("Duplicate review runtime is not configured.");
    this.name = "DuplicateReviewRuntimeUnavailable";
  }
}

export function isDuplicateReviewRuntimeUnavailable(
  value: unknown,
): value is DuplicateReviewRuntimeUnavailable {
  return value instanceof Error && value.name === "DuplicateReviewRuntimeUnavailable";
}

const globalForLegacyDuplicateReview = globalThis as typeof globalThis & {
  __txLegacyDuplicateReviewRuntimes?: Map<string, DuplicateReviewRuntime>;
};

export function getDuplicateReviewRuntime(): DuplicateReviewRuntime {
  const mode = loadRuntimeEnvironment().appRuntimeMode;
  if (mode === "production-aws") throw new DuplicateReviewRuntimeUnavailable();

  const runtimes = globalForLegacyDuplicateReview.__txLegacyDuplicateReviewRuntimes ??
    new Map<string, DuplicateReviewRuntime>();
  globalForLegacyDuplicateReview.__txLegacyDuplicateReviewRuntimes = runtimes;
  let runtime = runtimes.get(mode);
  if (!runtime) {
    try {
      runtime = Object.freeze({
        service: new DuplicateReviewService(
          new PostgresqlDuplicateReviewRepository(getApplicationTenantRunner()),
        ),
      });
    } catch {
      throw new DuplicateReviewRuntimeUnavailable();
    }
    runtimes.set(mode, runtime);
  }
  return runtime;
}
