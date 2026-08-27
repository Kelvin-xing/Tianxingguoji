import { getPortalRuntime, PortalRuntimeUnavailable } from "../../../../../modules/external-portal/server.ts";
import { createPortalSessionHandlers } from "./handler.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const defaultHandlers = createPortalSessionHandlers({
  redeem: async ({ accessKey, idempotencyKey, requestId }) => getPortalRuntime().service.redeem({ accessKey, idempotencyKey, requestId }),
  revokeSession: async ({ sessionSecret, requestId }) => getPortalRuntime().service.revokeSession({ sessionSecret, requestId }),
});
export const POST = defaultHandlers.POST;
export const DELETE = defaultHandlers.DELETE;
