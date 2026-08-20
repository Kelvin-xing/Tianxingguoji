import { PortalRuntimeUnavailable } from "../../../../../modules/external-portal/server.ts";
import { createPortalSessionHandlers } from "./handler.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const defaultHandlers = createPortalSessionHandlers({
  redeem: async () => { throw new PortalRuntimeUnavailable(); },
  revokeSession: async () => { throw new PortalRuntimeUnavailable(); },
});
export const POST = defaultHandlers.POST;
export const DELETE = defaultHandlers.DELETE;
