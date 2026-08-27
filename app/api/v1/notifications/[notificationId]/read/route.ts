import { requireApiRequestAccessContext } from "@/app/api/v1/request-access";
import { getApplicationTenantRunner } from "@/modules/shared/server";
import { createApiError, handleApiRequest, IDEMPOTENCY_KEY_PATTERN, type JsonValue } from "@/modules/shared/public";
import { NotificationHttpError, NotificationHttpRepository } from "@/modules/notifications/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: Request, route: { params: Promise<{ notificationId: string }> }): Promise<Response> {
  return handleApiRequest(request, async () => {
    try {
      const actor = await requireApiRequestAccessContext();
      const { notificationId } = await route.params;
      if (!UUID.test(notificationId)) throw createApiError("NOT_FOUND");
      const body = await readBody(request);
      const expectedRecordVersion = body.expected_record_version;
      if (typeof expectedRecordVersion !== "number" || !Number.isSafeInteger(expectedRecordVersion) || expectedRecordVersion < 1) {
        throw createApiError("VALIDATION_FAILED");
      }
      const idempotencyKey = request.headers.get("idempotency-key");
      if (!idempotencyKey || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
        throw createApiError("INVALID_REQUEST");
      }
      const row = await new NotificationHttpRepository(getApplicationTenantRunner()).markRead({
        organizationId: actor.organizationId, userId: actor.userId, notificationId, expectedRecordVersion, idempotencyKey,
      });
      return { id: row.id, record_version: row.record_version, status: row.status } satisfies JsonValue;
    } catch (error) {
      if (error instanceof NotificationHttpError) {
        if (error.code === "NOT_FOUND") throw createApiError("NOT_FOUND");
        if (error.code === "CONFLICT") throw createApiError("CONFLICT");
        throw createApiError("STALE_VERSION");
      }
      throw error;
    }
  });
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  let value: unknown;
  try { value = await request.json(); } catch { throw createApiError("INVALID_REQUEST"); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw createApiError("INVALID_REQUEST");
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => key !== "expected_record_version")) throw createApiError("VALIDATION_FAILED");
  return body;
}
