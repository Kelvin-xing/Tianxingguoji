import { getReferralSourceRuntime } from "@/modules/crm/server";
import { requireApiRequestAccessContext } from "@/app/api/v1/request-access";
import { createApiError, createRequestContext, errorResponse, handleApiRequest,
  successResponse } from "@/modules/shared/public";

import { acknowledgementData, mapReferralSourceError, parseReferralSourceUpdate,
  sourceData } from "../handler.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { readonly params: Promise<{ readonly sourceId: string }> };
export function GET(request: Request, context: Context): Promise<Response> {
  return handleApiRequest(request, async () => {
    try {
      const { sourceId } = await context.params;
      const actor = await requireApiRequestAccessContext();
      const source = await getReferralSourceRuntime().service.find(actor, sourceId);
      if (!source) throw createApiError("NOT_FOUND");
      return sourceData(source);
    } catch (error) { throw mapReferralSourceError(error); }
  });
}
export async function PATCH(request: Request, context: Context): Promise<Response> {
  const requestContext = createRequestContext(request);
  try {
    const { sourceId } = await context.params;
    const command = await parseReferralSourceUpdate(request, sourceId, requestContext.requestId);
    const actor = await requireApiRequestAccessContext();
    const result = await getReferralSourceRuntime().service.update({ actor, command });
    return successResponse(requestContext, acknowledgementData(result));
  } catch (error) { return errorResponse(requestContext, mapReferralSourceError(error)); }
}
