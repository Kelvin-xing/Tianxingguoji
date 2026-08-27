import { getPortalRuntime, PortalRuntimeUnavailable } from "../../../../../modules/external-portal/server.ts";
import { randomUUID } from "node:crypto";
import { PORTAL_SESSION_COOKIE_NAME } from "../sessions/handler.ts";
import { createPortalWorkspaceGetHandler, readPortalCookie } from "./handler.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const defaultGet = createPortalWorkspaceGetHandler({
  getSessionSecret: async (request) => readPortalCookie(
    request?.headers.get("cookie") ?? null,
    PORTAL_SESSION_COOKIE_NAME,
  ) ?? null,
  readWorkspace: async ({ sessionSecret }) => getPortalRuntime().service.readWorkspace({ sessionSecret, requestId: randomUUID() }),
});
export const GET = defaultGet;
