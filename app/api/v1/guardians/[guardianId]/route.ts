import { getProfileMaintenanceRuntime } from "@/modules/crm/server";
import { requireIdentityActor } from "@/modules/identity/web";
import { createRequestContext, errorResponse, successResponse } from "@/modules/shared/public";

import {
  assertProfileMaintenanceCapability,
  mapProfileMaintenanceError,
  parseGuardianProfileUpdate,
  toProfileAcknowledgement,
} from "../../profile-maintenance-handler.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  context: { readonly params: Promise<{ readonly guardianId: string }> },
): Promise<Response> {
  const requestContext = createRequestContext(request);
  try {
    const { guardianId } = await context.params;
    const command = await parseGuardianProfileUpdate(request, guardianId, requestContext.requestId);
    const actor = await requireIdentityActor();
    assertProfileMaintenanceCapability(actor);
    const acknowledgement = await getProfileMaintenanceRuntime().service.updateGuardian({ actor, command });
    return successResponse(requestContext, { guardian: toProfileAcknowledgement(acknowledgement) });
  } catch (error) {
    return errorResponse(requestContext, mapProfileMaintenanceError(error));
  }
}
