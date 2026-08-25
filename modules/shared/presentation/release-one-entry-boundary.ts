import { createApiError, errorResponse } from "./api-contract.ts";
import { createRequestContext } from "./request-context.ts";

/**
 * Retained historical Route Handlers use the normal private API envelope while
 * remaining indistinguishable from a route that is absent from Release 1.
 */
export function releaseOneExcludedEntryResponse(request: Request): Response {
  const context = createRequestContext(request);
  return errorResponse(context, createApiError("NOT_FOUND"));
}
