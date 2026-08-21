import { PortalPolicyError } from "../../../../../modules/external-portal/public.ts";
import { mapPortalErrorToPublicResponse } from "../../../../../modules/external-portal/public.ts";
import {
  PortalRepositoryError,
  PortalRuntimeUnavailable,
} from "../../../../../modules/external-portal/server.ts";

export const PORTAL_SESSION_COOKIE_NAME = "__Host-tx_portal_session";
const NO_STORE = { "Cache-Control": "private, no-store, max-age=0", Pragma: "no-cache" };
const COOKIE_OPTIONS = "Path=/; HttpOnly; Secure; SameSite=Strict; Priority=High";

export interface PortalSessionRouteDependencies {
  redeem(input: { readonly accessKey: string }): Promise<{
    readonly sessionSecret: string;
    readonly absoluteExpiresAt: string;
  }>;
  revokeSession(input: { readonly sessionSecret: string }): Promise<void>;
}

export function createPortalSessionHandlers(deps: PortalSessionRouteDependencies) {
  return {
    POST: async (request: Request): Promise<Response> => {
      try {
        const body = await readBody(request);
        const accessKey = body.access_key;
        if (typeof accessKey !== "string" || accessKey.length < 16 || accessKey.length > 1024) {
          return invalidRequest();
        }
        const result = await deps.redeem({ accessKey });
        const expires = new Date(result.absoluteExpiresAt);
        if (!Number.isFinite(expires.getTime())) throw new PortalRuntimeUnavailable();
        return json({ status: "active", expires_at: result.absoluteExpiresAt }, 201, {
          "Set-Cookie": `${PORTAL_SESSION_COOKIE_NAME}=${result.sessionSecret}; Expires=${expires.toUTCString()}; ${COOKIE_OPTIONS}`,
        });
      } catch (error) {
        return publicError(error);
      }
    },
    DELETE: async (request: Request): Promise<Response> => {
      const secret = readCookie(request.headers.get("cookie"), PORTAL_SESSION_COOKIE_NAME);
      const clearCookie = {
        "Set-Cookie": `${PORTAL_SESSION_COOKIE_NAME}=; Max-Age=0; ${COOKIE_OPTIONS}`,
      };
      try {
        if (secret) await deps.revokeSession({ sessionSecret: secret });
      } catch (error) {
        if (error instanceof PortalRuntimeUnavailable) {
          return json({ error: { code: error.code } }, 503, clearCookie);
        }
      }
      return json({ status: "signed_out" }, 200, clearCookie);
    },
  };
}

function json(body: unknown, status: number, headers?: HeadersInit): Response {
  return Response.json(body, { status, headers: { ...NO_STORE, ...headers } });
}

function invalidRequest(): Response {
  return json({ error: { code: "PORTAL_REQUEST_INVALID" } }, 400);
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await request.json();
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error();
    return body as Record<string, unknown>;
  } catch {
    return {};
  }
}

function publicError(error: unknown): Response {
  if (error instanceof PortalRuntimeUnavailable) {
    return json({ error: { code: error.code } }, 503);
  }
  let code = error instanceof PortalPolicyError ? error.code : null;
  if (error instanceof PortalRepositoryError) {
    code = error.code === "PORTAL_SESSION_LIMIT_REACHED"
      ? "PORTAL_SESSION_LIMIT_REACHED"
      : "PORTAL_SECRET_INVALID";
  }
  if (code === "PORTAL_SESSION_LIMIT_REACHED") {
    return json({ error: { code: "PORTAL_ACCESS_INVALID" } }, 401);
  }
  if (code) {
    const mapped = mapPortalErrorToPublicResponse(code);
    return json({ error: { code: mapped.code } }, mapped.httpStatus);
  }
  return json({ error: { code: "PORTAL_RUNTIME_UNAVAILABLE" } }, 503);
}

function readCookie(header: string | null, name: string): string | undefined {
  return header?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}
