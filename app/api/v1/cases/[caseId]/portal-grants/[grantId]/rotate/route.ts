import { authenticateInternalPortalRequest } from "../../handler.ts";
import { portalGrantOperations } from "../../route.ts";
import { createPortalGrantRotateHandler } from "./handler.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const POST = createPortalGrantRotateHandler({
  authenticateInternal: authenticateInternalPortalRequest, ...portalGrantOperations,
});
export { POST };
