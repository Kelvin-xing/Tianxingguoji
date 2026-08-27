import { getReferralSourceRuntime } from "@/modules/crm/server";
import { requireApiRequestAccessContext } from "@/app/api/v1/request-access";
import { createRequestContext, errorResponse, handleApiRequest, successResponse,
  type JsonValue } from "@/modules/shared/public";

import { acknowledgementData, mapReferralSourceError, parseReferralSourceCreate,
  parseReferralSourceListFilter, sourceData } from "./handler.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return handleApiRequest(request, async () => {
    try {
      const actor = await requireApiRequestAccessContext();
      const result = await getReferralSourceRuntime().service.list(actor, parseReferralSourceListFilter(request));
      return { items: result.items.map(sourceData), next_cursor: result.nextCursor } satisfies JsonValue;
    } catch (error) { throw mapReferralSourceError(error); }
  });
}

export async function POST(request: Request): Promise<Response> {
  const context = createRequestContext(request);
  try {
    const command = await parseReferralSourceCreate(request, context.requestId);
    const actor = await requireApiRequestAccessContext();
    const result = await getReferralSourceRuntime().service.create({ actor, command });
    return successResponse(context, acknowledgementData(result), 201);
  } catch (error) { return errorResponse(context, mapReferralSourceError(error)); }
}
