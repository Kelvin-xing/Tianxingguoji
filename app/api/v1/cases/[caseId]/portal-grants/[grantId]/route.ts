import type { PortalGrantRouteDependencies } from "../route.ts";
import { RequestInvalid, authenticateInternalPortalRequest, mapInternalError, portalJson, readIdempotencyKey, readObject, requireTrustedMutationOrigin } from "../route.ts";
import { PortalRuntimeUnavailable } from "../../../../../../../modules/external-portal/server.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type ItemContext = { readonly params: Promise<{ readonly caseId: string; readonly grantId: string }> };

export function createPortalGrantItemHandlers(deps: PortalGrantRouteDependencies) {
  return { DELETE: async (request: Request, context: ItemContext) => {
    try {
      requireTrustedMutationOrigin(request);
      const { caseId, grantId } = await context.params;
      if (!UUID.test(caseId) || !UUID.test(grantId)) throw new RequestInvalid();
      const idempotencyKey = readIdempotencyKey(request);
      const body = await readObject(request);
      if (!Number.isSafeInteger(body.expected_version) || Number(body.expected_version) < 1 || typeof body.reason_code !== "string" || body.reason_code.length > 128) throw new RequestInvalid();
      const actor = await deps.authenticateInternal(request);
      if (!actor) return portalJson({ error: { code: "PORTAL_AUTHENTICATION_REQUIRED" } }, 401);
      const result = await deps.revokeGrant({ actorUserId: actor.actorUserId, caseId, grantId, expectedVersion: Number(body.expected_version), reasonCode: body.reason_code, idempotencyKey });
      return portalJson({ grant_id: result.grantId, status: result.status, record_version: result.recordVersion }, 200);
    } catch (error) { return mapInternalError(error); }
  } };
}

const defaultHandlers = createPortalGrantItemHandlers({
  authenticateInternal: authenticateInternalPortalRequest,
  listGrants: async () => { throw new PortalRuntimeUnavailable(); },
  issueGrant: async () => { throw new PortalRuntimeUnavailable(); },
  revokeGrant: async () => { throw new PortalRuntimeUnavailable(); },
  rotateGrant: async () => { throw new PortalRuntimeUnavailable(); },
});
export const DELETE = defaultHandlers.DELETE;
