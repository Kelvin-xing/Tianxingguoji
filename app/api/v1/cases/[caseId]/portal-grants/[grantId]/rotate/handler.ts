import type { PortalGrantRouteDependencies } from "../../handler.ts";
import {
  RequestInvalid,
  isIsoDate,
  mapInternalError,
  portalJson,
  readIdempotencyKey,
  readObject,
  requireTrustedMutationOrigin,
} from "../../handler.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type ItemContext = {
  readonly params: Promise<{ readonly caseId: string; readonly grantId: string }>;
};

export function createPortalGrantRotateHandler(deps: PortalGrantRouteDependencies) {
  return async (request: Request, context: ItemContext) => {
    try {
      requireTrustedMutationOrigin(request);
      const { caseId, grantId } = await context.params;
      if (!UUID.test(caseId) || !UUID.test(grantId)) throw new RequestInvalid();
      const idempotencyKey = readIdempotencyKey(request);
      const body = await readObject(request);
      if (
        !Number.isSafeInteger(body.expected_version) ||
        Number(body.expected_version) < 1 ||
        !isIsoDate(body.expires_at)
      ) {
        throw new RequestInvalid();
      }
      const actor = await deps.authenticateInternal(request);
      if (!actor) {
        return portalJson({ error: { code: "PORTAL_AUTHENTICATION_REQUIRED" } }, 401);
      }
      const result = await deps.rotateGrant({
        actorUserId: actor.actorUserId,
        caseId,
        grantId,
        expectedVersion: Number(body.expected_version),
        expiresAt: body.expires_at,
        idempotencyKey,
      });
      return portalJson({
        grant_id: result.grantId,
        raw_secret_once: result.rawSecretOnce,
        fingerprint: result.fingerprint,
        expires_at: result.expiresAt,
        status: result.status,
        record_version: result.recordVersion,
      }, 201);
    } catch (error) {
      return mapInternalError(error);
    }
  };
}
