import { requireApiRequestAccessContext } from "@/app/api/v1/request-access";
import { hasRequestCapability } from "@/modules/access/public";
import { createApiError, handleApiRequest, type JsonValue } from "@/modules/shared/public";
import { getApplicationTenantRunner } from "@/modules/shared/server";
import {
  PostgresqlSchoolDirectoryRepository,
  SchoolResolutionError,
} from "@/modules/schools/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handleApiRequest(request, async () => {
    const actor = await requireApiRequestAccessContext();
    if (!hasRequestCapability(actor, "schools.read")) throw createApiError("FORBIDDEN");

    try {
      const items = await new PostgresqlSchoolDirectoryRepository(
        getApplicationTenantRunner(),
      ).list({
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
      });
      return {
        items: items.map(toDirectoryItem),
      } satisfies JsonValue;
    } catch (error) {
      if (error instanceof SchoolResolutionError) {
        throw createApiError("SERVICE_UNAVAILABLE");
      }
      throw error;
    }
  });
}

function toDirectoryItem(
  item: Awaited<ReturnType<PostgresqlSchoolDirectoryRepository["list"]>>[number],
): JsonValue {
  const fields: Record<string, JsonValue> = Object.fromEntries(
    Object.entries(item.view.fields),
  ) as Record<string, JsonValue>;
  return {
    school_id: item.view.schoolId,
    source_school_key: item.view.sourceSchoolKey,
    base_snapshot_id: item.pin.baseSnapshotId,
    resolved_revision_id: item.pin.resolvedRevisionId,
    overlay_revision_id: item.pin.overlayRevisionId,
    resolution_sha256: item.pin.resolutionSha256,
    fields,
  };
}
