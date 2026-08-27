import "server-only";

import {
  isRequestAccessContextError,
  resolveCurrentRequestAccessContext,
} from "@/modules/access/server";
import type { AccessContext } from "@/modules/access/public";
import { createApiError } from "@/modules/shared/public";

/** Stable App Router boundary for current Session + request-time Access union. */
export async function requireApiRequestAccessContext(): Promise<AccessContext> {
  try {
    return await resolveCurrentRequestAccessContext();
  } catch (error) {
    if (isRequestAccessContextError(error, "REQUEST_ACCESS_UNAUTHENTICATED")) {
      throw createApiError("UNAUTHENTICATED");
    }
    if (isRequestAccessContextError(error, "REQUEST_ACCESS_FORBIDDEN")) {
      throw createApiError("FORBIDDEN");
    }
    throw createApiError("SERVICE_UNAVAILABLE");
  }
}
