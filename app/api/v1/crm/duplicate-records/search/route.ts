import { getDuplicateReviewRuntime } from "@/modules/crm/server";
import { requireIdentityActor } from "@/modules/identity/web";
import { handleApiRequest } from "@/modules/shared/public";

import { mapDuplicateReviewError, parseRecordSearch, searchItemData } from "../../duplicate-handler.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handleApiRequest(request, async () => {
    try {
      const input = await parseRecordSearch(request);
      const actor = await requireIdentityActor();
      const items = await getDuplicateReviewRuntime().service.searchRecords(actor, input.entityType, input.query);
      return items.map(searchItemData);
    } catch (error) { throw mapDuplicateReviewError(error); }
  });
}
