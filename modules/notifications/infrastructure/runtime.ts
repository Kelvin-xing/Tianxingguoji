import "server-only";

import type { InAppNotificationService } from "../application/service.ts";
import { InAppNotificationService as NotificationService } from "../application/service.ts";
import { PostgresqlInAppNotificationRepository } from "./postgresql-repository.ts";
import { getApplicationTenantRunner } from "../../shared/server.ts";
import { loadLocalSyntheticConfig } from "../../../lib/runtime/local-synthetic-config.ts";

export interface InAppNotificationRuntime {
  readonly service: InAppNotificationService;
}

export class InAppNotificationRuntimeUnavailable extends Error {
  constructor() {
    super("In-app notification runtime is not configured.");
    this.name = "InAppNotificationRuntimeUnavailable";
  }
}

/** Only the approved HK RDS worker composition may install notification delivery. */
export function getInAppNotificationRuntime(): InAppNotificationRuntime {
  try {
    const config = loadLocalSyntheticConfig();
    if (!config.organizationId) throw new InAppNotificationRuntimeUnavailable();
    const runner = getApplicationTenantRunner();
    return Object.freeze({
      service: new NotificationService({
        repository: new PostgresqlInAppNotificationRepository({ runner, organizationId: config.organizationId }),
      }),
    });
  } catch (error) {
    if (error instanceof InAppNotificationRuntimeUnavailable) throw error;
    throw new InAppNotificationRuntimeUnavailable();
  }
}
