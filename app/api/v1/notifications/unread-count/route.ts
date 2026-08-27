import { requireApiRequestAccessContext } from "@/app/api/v1/request-access";
import { getApplicationTenantRunner } from "@/modules/shared/server";
import { handleApiRequest, type JsonValue } from "@/modules/shared/public";
import { NotificationHttpRepository } from "@/modules/notifications/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handleApiRequest(request, async () => {
    const actor = await requireApiRequestAccessContext();
    const unread_count = await new NotificationHttpRepository(getApplicationTenantRunner()).unreadCount({
      organizationId: actor.organizationId, userId: actor.userId,
    });
    return { unread_count } satisfies JsonValue;
  });
}
