import { requireApiRequestAccessContext } from "@/app/api/v1/request-access";
import { getDeletionReviewRuntime } from "@/modules/crm/server";
import { handleApiRequest } from "@/modules/shared/public";

import {
  deletionDecisionData,
  mapDeletionReviewError,
  parseDeletionDecision,
} from "../../../deletion-handler.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { readonly params: Promise<{ readonly requestId: string }> },
) {
  return handleApiRequest(request, async (requestContext) => {
    try {
      const { requestId } = await context.params;
      const command = await parseDeletionDecision(
        request,
        requestId,
        requestContext.requestId,
      );
      const actor = await requireApiRequestAccessContext();
      const result = await getDeletionReviewRuntime().service.decideDeletion({
        actor,
        command,
      });
      return deletionDecisionData(result);
    } catch (error) {
      throw mapDeletionReviewError(error);
    }
  });
}
