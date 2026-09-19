import { requireApiRequestAccessContext } from "@/app/api/v1/request-access";
import { getApplicationTenantRunner } from "@/modules/shared/server";
import { createApiError, handleApiRequest, type JsonValue } from "@/modules/shared/public";
import { AuditReadError, PostgreSqlAuditReadRepository } from "@/modules/audit/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handleApiRequest(request, async () => {
    try {
      const actor = await requireApiRequestAccessContext();
      const params = new URL(request.url).searchParams;
      const scope = params.get("scope") ?? "business";
      const rawLimit = Number(params.get("limit") ?? 50);
      if (scope !== "business" && scope !== "security") throw new AuditReadError("INVALID");
      const rows = await new PostgreSqlAuditReadRepository(getApplicationTenantRunner()).list({
        organizationId: actor.organizationId,
        actor,
        scope,
        limit: rawLimit,
        before: params.get("before"),
      });
      return { items: rows.map((row) => ({
        id: row.id, event_type: row.eventType, action: row.action,
        resource_type: row.resourceType, resource_id: row.resourceId,
        outcome: row.outcome, request_id: row.requestId, occurred_at: row.occurredAt,
        actor_user_id: row.actorUserId, metadata: row.metadata,
      })) } satisfies JsonValue;
    } catch (error) {
      if (error instanceof AuditReadError) {
        if (error.code === "INVALID") throw createApiError("VALIDATION_FAILED");
        throw createApiError("FORBIDDEN");
      }
      throw error;
    }
  });
}
