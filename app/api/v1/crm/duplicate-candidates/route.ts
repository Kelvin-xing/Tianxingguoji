import { getDuplicateReviewRuntime } from "@/modules/crm/server";
import { requireIdentityActor } from "@/modules/identity/web";
import { createRequestContext, errorResponse, handleApiRequest, successResponse } from "@/modules/shared/public";

import { candidateData, mapDuplicateReviewError, parseCandidateCreate, parseCandidateQuery } from "../duplicate-handler.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handleApiRequest(request, async () => {
    try {
      const input = parseCandidateQuery(request); const actor = await requireIdentityActor();
      return (await getDuplicateReviewRuntime().service.listCandidates(actor, input.entityType, input.status))
        .map(candidateData);
    } catch (error) { throw mapDuplicateReviewError(error); }
  });
}

export async function POST(request: Request): Promise<Response> {
  const context = createRequestContext(request);
  try {
    const command = await parseCandidateCreate(request, context.requestId);
    const actor = await requireIdentityActor();
    const candidate = await getDuplicateReviewRuntime().service.createCandidate({ actor, command });
    return successResponse(context, candidateData(candidate), 201);
  } catch (error) { return errorResponse(context, mapDuplicateReviewError(error)); }
}
