import { requireApiRequestAccessContext } from "@/app/api/v1/request-access";
import { getApplicationTenantRunner } from "@/modules/shared/server";
import { createApiError, handleApiRequest, type JsonValue } from "@/modules/shared/public";
import { NotificationHttpError, NotificationHttpRepository } from "@/modules/notifications/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handleApiRequest(request, async () => {
    try {
      const actor = await requireApiRequestAccessContext();
      const rawLimit = new URL(request.url).searchParams.get("limit");
      const limit = rawLimit === null ? 100 : Number(rawLimit);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw createApiError("VALIDATION_FAILED");
      const rows = await new NotificationHttpRepository(getApplicationTenantRunner()).list({
        organizationId: actor.organizationId, userId: actor.userId, limit,
      });
      return { items: rows.map((row) => ({ ...row, allowed_actions: row.status === "unread" ? ["read", "resolve_target"] : ["resolve_target"] })) } satisfies JsonValue;
    } catch (error) {
      return mapError(error);
    }
  });
}

function mapError(error: unknown): never {
  if (error instanceof NotificationHttpError) {
    if (error.code === "NOT_FOUND") throw createApiError("NOT_FOUND");
    throw createApiError("STALE_VERSION");
  }
  throw error;
}
