import {
  assertExactKeys,
  mapInternalError,
  portalJson,
  readCaseId,
  readIdempotencyKey,
  readObject,
  requireTrustedMutationOrigin,
} from "../portal-grants/handler.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface PortalViewerRouteDependencies {
  authenticateInternal(request?: Request): Promise<{
    readonly actorUserId: string;
    readonly organizationId?: string;
    readonly workspaceCapabilities?: readonly string[];
    readonly roles?: readonly string[];
  } | null>;
  ensureViewer(input: {
    readonly actorUserId: string;
    readonly actor: {
      readonly organizationId?: string;
      readonly workspaceCapabilities?: readonly string[];
      readonly roles?: readonly string[];
    };
    readonly caseId: string;
    readonly guardianRelationshipId: string;
    readonly idempotencyKey: string;
  }): Promise<{
    readonly viewerId: string;
    readonly guardianRelationshipId: string;
    readonly status: "active" | "inactive";
    readonly recordVersion: number;
  }>;
}

type CaseContext = { readonly params: Promise<{ readonly caseId: string }> };

export function createPortalViewerCollectionHandlers(deps: PortalViewerRouteDependencies) {
  return {
    POST: async (request: Request, context: CaseContext): Promise<Response> => {
      try {
        requireTrustedMutationOrigin(request);
        const caseId = await readCaseId(context);
        const idempotencyKey = readIdempotencyKey(request);
        const body = await readObject(request);
        assertExactKeys(body, ["guardian_relationship_id"]);
        const guardianRelationshipId = String(body.guardian_relationship_id ?? "");
        if (!UUID.test(guardianRelationshipId)) {
          return portalJson({ error: { code: "PORTAL_REQUEST_INVALID" } }, 400);
        }
        const actor = await deps.authenticateInternal(request);
        if (!actor) {
          return portalJson({ error: { code: "PORTAL_AUTHENTICATION_REQUIRED" } }, 401);
        }
        const result = await deps.ensureViewer({
          actorUserId: actor.actorUserId,
          actor,
          caseId,
          guardianRelationshipId,
          idempotencyKey,
        });
        return portalJson({
          portal_viewer_id: result.viewerId,
          guardian_relationship_id: result.guardianRelationshipId,
          status: result.status,
          record_version: result.recordVersion,
        }, 201);
      } catch (error) {
        return mapInternalError(error);
      }
    },
  };
}
