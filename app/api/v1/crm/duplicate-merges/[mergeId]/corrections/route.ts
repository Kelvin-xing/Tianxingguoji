import { getDuplicateReviewRuntime } from "@/modules/crm/server";
import { requireIdentityActor } from "@/modules/identity/web";
import { handleApiRequest } from "@/modules/shared/public";

import { correctionData, mapDuplicateReviewError, parseCorrectionCreate } from "../../../duplicate-handler.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { readonly params: Promise<{ mergeId: string }> }) {
  return handleApiRequest(request, async (requestContext) => {
    try {
      const { mergeId } = await context.params;
      const command = await parseCorrectionCreate(request, mergeId, requestContext.requestId);
      const actor = await requireIdentityActor();
      return correctionData(await getDuplicateReviewRuntime().service.correctMerge({ actor, command }));
    } catch (error) { throw mapDuplicateReviewError(error); }
  });
}
