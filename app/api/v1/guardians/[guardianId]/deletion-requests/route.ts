import { getDeletionReviewRuntime } from "@/modules/crm/server";
import { requireIdentityActor } from "@/modules/identity/web";
import { handleApiRequest } from "@/modules/shared/public";

import { deletionReceiptData, mapDeletionReviewError, parseDeletionRequest } from "../../../crm/deletion-handler.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { readonly params: Promise<{ guardianId: string }> }) {
  return handleApiRequest(request, async (requestContext) => {
    try {
      const { guardianId } = await context.params;
      const command = await parseDeletionRequest(request, "guardian", guardianId, requestContext.requestId);
      const actor = await requireIdentityActor();
      return deletionReceiptData(await getDeletionReviewRuntime().service.requestDeletion({ actor, command }));
    } catch (error) { throw mapDeletionReviewError(error); }
  });
}
