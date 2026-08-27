import { requireApiRequestAccessContext } from "@/app/api/v1/request-access";
import { getReferralSourceRuntime } from "@/modules/crm/server";
import { createRequestContext, errorResponse, successResponse } from "@/modules/shared/public";

import { acknowledgementData, mapReferralSourceError, parseReferralSourceDeactivate } from "../../handler.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { readonly params: Promise<{ readonly sourceId: string }> }) {
  const requestContext = createRequestContext(request);
  try {
    const { sourceId } = await context.params;
    const command = await parseReferralSourceDeactivate(request, sourceId, requestContext.requestId);
    const actor = await requireApiRequestAccessContext();
    const result = await getReferralSourceRuntime().service.deactivate({ actor, command });
    return successResponse(requestContext, acknowledgementData(result));
  } catch (error) {
    return errorResponse(requestContext, mapReferralSourceError(error));
  }
}
