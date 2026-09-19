import { requireApiRequestAccessContext } from "@/app/api/v1/request-access";
import { getApplicationTenantRunner } from "@/modules/shared/server";
import { createApiError, handleApiRequest, type JsonValue } from "@/modules/shared/public";
import { NotificationHttpError, NotificationHttpRepository } from "@/modules/notifications/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: Request, route: { params: Promise<{ notificationId: string }> }): Promise<Response> {
  return handleApiRequest(request, async () => {
    const actor = await requireApiRequestAccessContext();
    const { notificationId } = await route.params;
    if (!UUID.test(notificationId)) throw createApiError("NOT_FOUND");
    const body = await request.json().catch(() => null) as unknown;
    if (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body as object).length !== 0) {
      throw createApiError("VALIDATION_FAILED");
    }
    try {
      const routeCode = await new NotificationHttpRepository(getApplicationTenantRunner()).resolveTarget({
        organizationId:actor.organizationId,userId:actor.userId,notificationId,
      });
      return {route_code:routeCode} satisfies JsonValue;
    } catch(error) {
      if(error instanceof NotificationHttpError) throw createApiError(error.code==='FORBIDDEN'?'FORBIDDEN':'NOT_FOUND');
      throw error;
    }
  });
}
