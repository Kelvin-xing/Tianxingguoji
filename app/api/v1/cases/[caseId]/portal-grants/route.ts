import { randomUUID } from "node:crypto";
import { getPortalRuntime } from "../../../../../../modules/external-portal/server.ts";
import {
  authenticateInternalPortalRequest,
  createPortalGrantCollectionHandlers,
  type PortalGrantRouteDependencies,
} from "./handler.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const portalGrantOperations = {
  listGrants: async (input: Parameters<NonNullable<PortalGrantRouteDependencies["listGrants"]>>[0]) => getPortalRuntime().service.listGrants({ actor: {
    actorUserId: input.actorUserId,
    organizationId: input.actor?.organizationId ?? "00000000-0000-4000-8000-000000000000",
    workspaceCapabilities: input.actor?.workspaceCapabilities ?? [],
    roles: input.actor?.roles ?? [],
  }, serviceCaseId: input.caseId }).then((grants) => grants.map((grant) => ({
    grantId: grant.id,
    portalViewerId: grant.portalViewerId,
    fingerprint: grant.secretFingerprint,
    expiresAt: new Date(grant.expiresAtMs).toISOString(),
    status: grant.status,
    recordVersion: grant.recordVersion,
  }))),
  issueGrant: async (input: Parameters<NonNullable<PortalGrantRouteDependencies["issueGrant"]>>[0]) => getPortalRuntime().service.issueGrant({ actor: {
    actorUserId: input.actorUserId,
    organizationId: input.actor?.organizationId ?? "00000000-0000-4000-8000-000000000000",
    workspaceCapabilities: input.actor?.workspaceCapabilities ?? [],
    roles: input.actor?.roles ?? [],
  }, serviceCaseId: input.caseId, portalViewerId: input.portalViewerId, idempotencyKey: input.idempotencyKey, requestId: randomUUID() }),
  revokeGrant: async (input: Parameters<NonNullable<PortalGrantRouteDependencies["revokeGrant"]>>[0]) => getPortalRuntime().service.revokeGrant({ actor: {
    actorUserId: input.actorUserId,
    organizationId: input.actor?.organizationId ?? "00000000-0000-4000-8000-000000000000",
    workspaceCapabilities: input.actor?.workspaceCapabilities ?? [],
    roles: input.actor?.roles ?? [],
  }, serviceCaseId: input.caseId, portalViewerId: "00000000-0000-4000-8000-000000000000", grantId: input.grantId, expectedRecordVersion: input.expectedVersion, reasonCode: input.reasonCode, idempotencyKey: input.idempotencyKey, requestId: randomUUID() }),
  rotateGrant: async (input: Parameters<NonNullable<PortalGrantRouteDependencies["rotateGrant"]>>[0]) => getPortalRuntime().service.reissueGrant({ actor: {
    actorUserId: input.actorUserId,
    organizationId: input.actor?.organizationId ?? "00000000-0000-4000-8000-000000000000",
    workspaceCapabilities: input.actor?.workspaceCapabilities ?? [],
    roles: input.actor?.roles ?? [],
  }, serviceCaseId: input.caseId, portalViewerId: "00000000-0000-4000-8000-000000000000", grantId: input.grantId, expectedRecordVersion: input.expectedVersion, idempotencyKey: input.idempotencyKey, requestId: randomUUID() }),
};

const defaultHandlers = createPortalGrantCollectionHandlers({
  authenticateInternal: authenticateInternalPortalRequest,
  ...portalGrantOperations,
} as PortalGrantRouteDependencies);

export const GET = defaultHandlers.GET;
export const POST = defaultHandlers.POST;
