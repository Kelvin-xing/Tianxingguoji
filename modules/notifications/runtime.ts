import type { InAppNotificationService } from "./service.ts";

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
  throw new InAppNotificationRuntimeUnavailable();
}
