import { requireApiRequestAccessContext } from "@/app/api/v1/request-access";
import {
  DatabaseTestSchoolFixtureError,
  ensureDatabaseTestResolvedSchoolFixture,
} from "@/modules/schools/server";
import { createApiError, handleApiRequest, type JsonValue } from "@/modules/shared/public";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handleApiRequest(request, async (requestContext) => {
    try {
      const actor = await requireApiRequestAccessContext();
      const schools = await ensureDatabaseTestResolvedSchoolFixture({
        actor,
        requestId: requestContext.requestId,
      });
      return {
        fixture_version: "env01-resolved-schools-v1",
        schools: schools.map((school) => ({
          school_id: school.schoolId,
          display_name: school.displayName,
          resolved_revision_id: school.resolvedRevisionId,
          resolution_sha256: school.resolutionSha256,
        })),
      } satisfies JsonValue;
    } catch (error) {
      if (error instanceof DatabaseTestSchoolFixtureError) {
        if (error.code === "DATABASE_TEST_SCHOOL_FIXTURE_FORBIDDEN") {
          throw createApiError("FORBIDDEN");
        }
        throw createApiError("SERVICE_UNAVAILABLE");
      }
      throw error;
    }
  });
}
