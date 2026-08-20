import { authenticateInternalPortalRequest } from "../../handler.ts";
import { PortalRuntimeUnavailable } from "../../../../../../../../modules/external-portal/server.ts";
import { createPortalGrantRotateHandler } from "./handler.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const POST = createPortalGrantRotateHandler({
  authenticateInternal: authenticateInternalPortalRequest, listGrants: async () => { throw new PortalRuntimeUnavailable(); }, issueGrant: async () => { throw new PortalRuntimeUnavailable(); }, revokeGrant: async () => { throw new PortalRuntimeUnavailable(); }, rotateGrant: async () => { throw new PortalRuntimeUnavailable(); },
});
export { POST };
