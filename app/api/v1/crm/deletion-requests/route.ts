import { getDeletionReviewRuntime } from "@/modules/crm/server";
import { requireIdentityActor } from "@/modules/identity/web";
import { handleApiRequest } from "@/modules/shared/public";

import { deletionSummaryData, mapDeletionReviewError, parseDeletionQueueQuery } from "../deletion-handler.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handleApiRequest(request, async () => {
    try {
      const entityType = parseDeletionQueueQuery(request); const actor = await requireIdentityActor();
      return (await getDeletionReviewRuntime().service.listDeletionRequests(actor, entityType))
        .map(deletionSummaryData);
    } catch (error) { throw mapDeletionReviewError(error); }
  });
}
