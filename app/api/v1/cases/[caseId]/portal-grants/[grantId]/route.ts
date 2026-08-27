import { authenticateInternalPortalRequest } from "../handler.ts";
import { portalGrantOperations } from "../route.ts";
import { createPortalGrantItemHandlers } from "./handler.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const defaultHandlers = createPortalGrantItemHandlers({
  authenticateInternal: authenticateInternalPortalRequest,
  ...portalGrantOperations,
});
export const DELETE = defaultHandlers.DELETE;
