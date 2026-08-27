import { getCaseReferralSourceRuntime } from "@/modules/cases/server";
import { requireApiRequestAccessContext } from "@/app/api/v1/request-access";
import { createApiError, createRequestContext, errorResponse, handleApiRequest,
  successResponse } from "@/modules/shared/public";

import { assignmentAcknowledgementData, assignmentsData, mapCaseReferralSourceError,
  parseCaseReferralSourceAssignment } from "./handler.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { readonly params: Promise<{ readonly caseId: string }> };

export function GET(request: Request, context: Context): Promise<Response> {
  return handleApiRequest(request, async () => {
    try {
      const { caseId } = await context.params;
      const actor = await requireApiRequestAccessContext();
      const result = await getCaseReferralSourceRuntime().service.read(actor, caseId);
      if (!result) throw createApiError("NOT_FOUND");
      return assignmentsData(result);
    } catch (error) { throw mapCaseReferralSourceError(error); }
  });
}
export async function POST(request: Request, context: Context): Promise<Response> {
  const requestContext = createRequestContext(request);
  try {
    const { caseId } = await context.params;
    const command = await parseCaseReferralSourceAssignment(request, caseId, requestContext.requestId);
    const actor = await requireApiRequestAccessContext();
    const result = await getCaseReferralSourceRuntime().service.assign({ actor, command });
    return successResponse(requestContext, assignmentAcknowledgementData(result));
  } catch (error) { return errorResponse(requestContext, mapCaseReferralSourceError(error)); }
}
