import { SESSION_COOKIE_NAME } from "../../../../../../modules/identity/server.ts";
import { IdentityRuntimeUnavailable, getIdentityRuntime } from "../../../../../../modules/identity/server.ts";
import { IdentityServiceError } from "../../../../../../modules/identity/server.ts";
import { PortalPolicyError } from "../../../../../../modules/external-portal/public.ts";
import {
  PortalRepositoryError,
  PortalRuntimeUnavailable,
} from "../../../../../../modules/external-portal/server.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const NO_STORE = { "Cache-Control": "private, no-store, max-age=0", Pragma: "no-cache" };

export interface PortalGrantSummary {
  readonly grantId: string;
  readonly portalViewerId: string;
  readonly fingerprint: string;
  readonly expiresAt: string;
  readonly status: "active" | "pending_approval" | "revoked" | "expired";
  readonly recordVersion: number;
}

export interface PortalGrantRouteDependencies {
  authenticateInternal(request?: Request): Promise<{ readonly actorUserId: string } | null>;
  listGrants(input: { readonly actorUserId: string; readonly caseId: string }): Promise<readonly PortalGrantSummary[]>;
  issueGrant(input: { readonly actorUserId: string; readonly caseId: string; readonly portalViewerId: string; readonly expiresAt: string; readonly idempotencyKey: string }): Promise<{ readonly grantId: string; readonly rawSecretOnce: string; readonly fingerprint: string; readonly expiresAt: string; readonly status: "active" | "pending_approval"; readonly recordVersion: number }>;
  revokeGrant(input: { readonly actorUserId: string; readonly caseId: string; readonly grantId: string; readonly expectedVersion: number; readonly reasonCode: string; readonly idempotencyKey: string }): Promise<{ readonly grantId: string; readonly status: "revoked"; readonly recordVersion: number }>;
  rotateGrant(input: { readonly actorUserId: string; readonly caseId: string; readonly grantId: string; readonly expectedVersion: number; readonly expiresAt: string; readonly idempotencyKey: string }): Promise<{ readonly grantId: string; readonly rawSecretOnce: string; readonly fingerprint: string; readonly expiresAt: string; readonly status: "active" | "pending_approval"; readonly recordVersion: number }>;
}

type CaseContext = { readonly params: Promise<{ readonly caseId: string }> };

export function createPortalGrantCollectionHandlers(deps: PortalGrantRouteDependencies) {
  return {
    GET: async (_request: Request, context: CaseContext) => {
      try {
        const caseId = await readCaseId(context);
        const actor = await deps.authenticateInternal(_request);
        if (!actor) return portalJson({ error: { code: "PORTAL_AUTHENTICATION_REQUIRED" } }, 401);
        const grants = await deps.listGrants({ actorUserId: actor.actorUserId, caseId });
        return portalJson({ grants: grants.map(toGrantJson) }, 200);
      } catch (error) { return mapInternalError(error); }
    },
    POST: async (request: Request, context: CaseContext) => {
      try {
        requireTrustedMutationOrigin(request);
        const caseId = await readCaseId(context);
        const idempotencyKey = readIdempotencyKey(request);
        const body = await readObject(request);
        if (!UUID.test(String(body.portal_viewer_id ?? "")) || !isIsoDate(body.expires_at)) throw new RequestInvalid();
        const actor = await deps.authenticateInternal(request);
        if (!actor) return portalJson({ error: { code: "PORTAL_AUTHENTICATION_REQUIRED" } }, 401);
        const result = await deps.issueGrant({ actorUserId: actor.actorUserId, caseId, portalViewerId: String(body.portal_viewer_id), expiresAt: String(body.expires_at), idempotencyKey });
        return portalJson({ grant_id: result.grantId, raw_secret_once: result.rawSecretOnce, fingerprint: result.fingerprint, expires_at: result.expiresAt, status: result.status, record_version: result.recordVersion }, 201);
      } catch (error) { return mapInternalError(error); }
    },
  };
}

export function portalJson(body: unknown, status: number, extraHeaders?: HeadersInit): Response {
  return Response.json(body, { status, headers: { ...NO_STORE, ...extraHeaders } });
}

export async function readObject(request: Request): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await request.json();
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new RequestInvalid(); }
}

export function readIdempotencyKey(request: Request): string {
  const value = request.headers.get("idempotency-key")?.trim() ?? "";
  if (!IDEMPOTENCY_KEY.test(value)) throw new RequestInvalid();
  return value;
}

export function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value));
}

export class RequestInvalid extends Error {}
export class UntrustedMutationOrigin extends Error {}

export function requireTrustedMutationOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (!origin) throw new UntrustedMutationOrigin();
  try {
    if (new URL(origin).origin !== new URL(request.url).origin) throw new UntrustedMutationOrigin();
  } catch (error) {
    if (error instanceof UntrustedMutationOrigin) throw error;
    throw new UntrustedMutationOrigin();
  }
}

export async function authenticateInternalPortalRequest(request?: Request): Promise<{ readonly actorUserId: string } | null> {
  const secret = readCookie(request?.headers.get("cookie") ?? null, SESSION_COOKIE_NAME);
  if (!secret) return null;
  const actor = await getIdentityRuntime().service.requireSession({ cookieSecret: secret, sensitiveAction: true });
  return { actorUserId: actor.userId };
}

export function mapInternalError(error: unknown): Response {
  if (error instanceof RequestInvalid) return portalJson({ error: { code: "PORTAL_REQUEST_INVALID" } }, 400);
  if (error instanceof UntrustedMutationOrigin) return portalJson({ error: { code: "PORTAL_ACCESS_DENIED" } }, 403);
  if (error instanceof IdentityRuntimeUnavailable || error instanceof PortalRuntimeUnavailable) return portalJson({ error: { code: "PORTAL_RUNTIME_UNAVAILABLE" } }, 503);
  if (error instanceof IdentityServiceError) return portalJson({ error: { code: "PORTAL_AUTHENTICATION_REQUIRED" } }, 401);
  if (error instanceof PortalPolicyError) {
    if (error.code === "PORTAL_VERSION_CONFLICT") return portalJson({ error: { code: "PORTAL_VERSION_CONFLICT" } }, 409);
    if (error.code === "PORTAL_INPUT_INVALID" || error.code === "PORTAL_EXPIRY_INVALID") return portalJson({ error: { code: "PORTAL_REQUEST_INVALID" } }, 400);
    return portalJson({ error: { code: "PORTAL_ACCESS_DENIED" } }, 403);
  }
  if (error instanceof PortalRepositoryError) {
    if (error.code === "PORTAL_VERSION_CONFLICT") return portalJson({ error: { code: "PORTAL_VERSION_CONFLICT" } }, 409);
    if (error.code === "PORTAL_IDEMPOTENCY_KEY_REUSED" || error.code === "PORTAL_GRANT_NOT_ACTIVE") return portalJson({ error: { code: "PORTAL_CONFLICT" } }, 409);
  }
  return portalJson({ error: { code: "PORTAL_RUNTIME_UNAVAILABLE" } }, 503);
}

function toGrantJson(grant: PortalGrantSummary) {
  return { grant_id: grant.grantId, portal_viewer_id: grant.portalViewerId, fingerprint: grant.fingerprint, expires_at: grant.expiresAt, status: grant.status, record_version: grant.recordVersion };
}

async function readCaseId(context: CaseContext): Promise<string> {
  const { caseId } = await context.params;
  if (!UUID.test(caseId)) throw new RequestInvalid();
  return caseId;
}

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

function readCookie(header: string | null, name: string): string | undefined {
  return header?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
}
