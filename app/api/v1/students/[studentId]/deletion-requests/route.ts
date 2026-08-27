import { getDeletionReviewRuntime } from "@/modules/crm/server";
import { requireApiRequestAccessContext } from "@/app/api/v1/request-access";
import { handleApiRequest } from "@/modules/shared/public";

import { deletionReceiptData, mapDeletionReviewError, parseDeletionRequest } from "../../../crm/deletion-handler.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { readonly params: Promise<{ studentId: string }> }) {
  return handleApiRequest(request, async (requestContext) => {
    try {
      const { studentId } = await context.params;
      const command = await parseDeletionRequest(request, "student", studentId, requestContext.requestId);
      const actor = await requireApiRequestAccessContext();
      return deletionReceiptData(await getDeletionReviewRuntime().service.requestDeletion({ actor, command }));
    } catch (error) { throw mapDeletionReviewError(error); }
  });
}
