import { getDuplicateReviewRuntime } from "@/modules/crm/server";
import { requireIdentityActor } from "@/modules/identity/web";
import { handleApiRequest } from "@/modules/shared/public";

import { mapDuplicateReviewError, mergeReceiptData, parseMergeCreate } from "../../../duplicate-handler.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { readonly params: Promise<{ candidateId: string }> }) {
  return handleApiRequest(request, async (requestContext) => {
    try {
      const { candidateId } = await context.params;
      const command = await parseMergeCreate(request, candidateId, requestContext.requestId);
      const actor = await requireIdentityActor();
      return mergeReceiptData(await getDuplicateReviewRuntime().service.mergeCandidate({ actor, command }));
    } catch (error) { throw mapDuplicateReviewError(error); }
  });
}
