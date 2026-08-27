import { getDeletionReviewRuntime } from "@/modules/crm/server";
import { requireApiRequestAccessContext } from "@/app/api/v1/request-access";
import { handleApiRequest } from "@/modules/shared/public";

import {
  deletionSummaryData,
  mapDeletionReviewError,
  parseDeletionQueueQuery,
} from "../deletion-handler.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handleApiRequest(request, async () => {
    try {
      const entityType = parseDeletionQueueQuery(request);
      const actor = await requireApiRequestAccessContext();
      const items =
        await getDeletionReviewRuntime().service.listDeletionRequests(
          actor,
          entityType,
        );
      return items.map(deletionSummaryData);
    } catch (error) {
      throw mapDeletionReviewError(error);
    }
  });
}
