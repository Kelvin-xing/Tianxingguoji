import { getDuplicateReviewRuntime } from "@/modules/crm/server";
import { requireIdentityActor } from "@/modules/identity/web";
import { createApiError, handleApiRequest } from "@/modules/shared/public";

import { detailData, mapDuplicateReviewError } from "../../duplicate-handler.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { readonly params: Promise<{ candidateId: string }> }) {
  return handleApiRequest(request, async () => {
    try {
      const { candidateId } = await context.params; const actor = await requireIdentityActor();
      const detail = await getDuplicateReviewRuntime().service.findCandidate(actor, candidateId);
      if (!detail) throw createApiError("NOT_FOUND");
      return detailData(detail);
    } catch (error) { throw mapDuplicateReviewError(error); }
  });
}
