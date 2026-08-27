import { requireApiRequestAccessContext } from "@/app/api/v1/request-access";
import { createApiError, handleApiRequest, type JsonValue } from "@/modules/shared/public";
import {
  getSchoolOptionsRuntime,
  isSchoolOptionsError,
  SchoolOptionsRuntimeUnavailable,
} from "@/modules/schools/server";
import { parseSchoolOptionsRequest } from "./route-support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handleApiRequest(request, async () => {
    try {
      const query = parseSchoolOptionsRequest(request);
      const actor = await requireApiRequestAccessContext();
      const result = await getSchoolOptionsRuntime().service.list({ actor,...query });
      return {
        items: result.items.map((item) => ({
          school_id: item.schoolId,
          display_name: item.displayName,
          resolved_revision_id: item.resolvedRevisionId,
          resolution_sha256: item.resolutionSha256,
        })),
        next_cursor: result.nextCursor,
      } satisfies JsonValue;
    } catch (error) {
      if (error instanceof SchoolOptionsRuntimeUnavailable) throw createApiError("SERVICE_UNAVAILABLE");
      if (isSchoolOptionsError(error)) {
        if (error.code === "SCHOOL_OPTIONS_INVALID") throw createApiError("INVALID_REQUEST");
        if (error.code === "SCHOOL_OPTIONS_FORBIDDEN") throw createApiError("FORBIDDEN");
        throw createApiError("SERVICE_UNAVAILABLE");
      }
      throw error;
    }
  });
}
