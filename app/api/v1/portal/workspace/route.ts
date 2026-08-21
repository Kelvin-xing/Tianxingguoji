import { PortalRuntimeUnavailable } from "../../../../../modules/external-portal/server.ts";
import { PORTAL_SESSION_COOKIE_NAME } from "../sessions/handler.ts";
import { createPortalWorkspaceGetHandler, readPortalCookie } from "./handler.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const defaultGet = createPortalWorkspaceGetHandler({
  getSessionSecret: async (request) => readPortalCookie(
    request?.headers.get("cookie") ?? null,
    PORTAL_SESSION_COOKIE_NAME,
  ) ?? null,
  readWorkspace: async () => { throw new PortalRuntimeUnavailable(); },
});
export const GET = defaultGet;
