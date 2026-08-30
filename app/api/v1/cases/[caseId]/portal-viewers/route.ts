import { randomUUID } from "node:crypto";

import { getPortalRuntime } from "@/modules/external-portal/server";
import { authenticateInternalPortalRequest } from "../portal-grants/handler.ts";
import {
  createPortalViewerCollectionHandlers,
  type PortalViewerRouteDependencies,
} from "./handler.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const defaultHandlers = createPortalViewerCollectionHandlers({
  authenticateInternal: authenticateInternalPortalRequest,
  ensureViewer: async (input) => {
    const viewer = await getPortalRuntime().service.ensureViewer({
      actor: {
        actorUserId: input.actorUserId,
        organizationId: input.actor.organizationId ?? "00000000-0000-4000-8000-000000000000",
        workspaceCapabilities: input.actor.workspaceCapabilities ?? [],
        roles: input.actor.roles ?? [],
      },
      serviceCaseId: input.caseId,
      guardianRelationshipId: input.guardianRelationshipId,
      idempotencyKey: input.idempotencyKey,
      requestId: randomUUID(),
    });
    return {
      viewerId: viewer.id,
      guardianRelationshipId: viewer.guardianRelationshipId,
      status: viewer.status,
      recordVersion: viewer.recordVersion,
    };
  },
} satisfies PortalViewerRouteDependencies);

export const POST = defaultHandlers.POST;
