import { getStudentReadRuntime, GuardianRelationshipRuntimeUnavailable, StudentReadError } from "@/modules/crm/server";
import { requireIdentityActor } from "@/modules/identity/web";
import { createApiError, handleApiRequest, type JsonValue } from "@/modules/shared/public";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handleApiRequest(request, async () => {
    try {
      const actor = await requireIdentityActor();
      const students = await getStudentReadRuntime().service.listStudents(actor);
      return { students: students.map((student) => ({ ...student })) } satisfies JsonValue;
    } catch (error) {
      if (error instanceof StudentReadError && error.code === "STUDENT_READ_FORBIDDEN") {
        throw createApiError("FORBIDDEN");
      }
      if (error instanceof GuardianRelationshipRuntimeUnavailable) {
        throw createApiError("SERVICE_UNAVAILABLE");
      }
      throw error;
    }
  });
}
