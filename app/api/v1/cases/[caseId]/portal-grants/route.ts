import { PortalRuntimeUnavailable } from "../../../../../../modules/external-portal/server.ts";
import {
  authenticateInternalPortalRequest,
  createPortalGrantCollectionHandlers,
  type PortalGrantRouteDependencies,
} from "./handler.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const unavailableOperations = {
  listGrants: async () => { throw new PortalRuntimeUnavailable(); },
  issueGrant: async () => { throw new PortalRuntimeUnavailable(); },
  revokeGrant: async () => { throw new PortalRuntimeUnavailable(); },
  rotateGrant: async () => { throw new PortalRuntimeUnavailable(); },
};

const defaultHandlers = createPortalGrantCollectionHandlers({
  authenticateInternal: authenticateInternalPortalRequest,
  ...unavailableOperations,
} as PortalGrantRouteDependencies);

export const GET = defaultHandlers.GET;
export const POST = defaultHandlers.POST;
