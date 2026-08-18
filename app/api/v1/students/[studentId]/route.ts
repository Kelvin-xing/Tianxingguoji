import { getStudentReadRuntime, GuardianRelationshipRuntimeUnavailable, StudentReadError } from "@/modules/crm/server";
import { requireIdentityActor } from "@/modules/identity/web";
import { createApiError, handleApiRequest, type JsonValue } from "@/modules/shared/public";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { readonly params: Promise<{ readonly studentId: string }> },
): Promise<Response> {
  return handleApiRequest(request, async () => {
    const { studentId } = await context.params;
    try {
      const actor = await requireIdentityActor();
      const student = await getStudentReadRuntime().service.findStudent(actor, studentId);
      if (!student) throw createApiError("NOT_FOUND");
      return {
        student: {
          ...student,
          guardians: student.guardians.map((guardian) => ({ ...guardian })),
        },
      } satisfies JsonValue;
    } catch (error) {
      if (error instanceof StudentReadError) {
        if (error.code === "STUDENT_READ_FORBIDDEN") throw createApiError("FORBIDDEN");
        if (error.code === "STUDENT_ID_INVALID") throw createApiError("NOT_FOUND");
      }
      if (error instanceof GuardianRelationshipRuntimeUnavailable) {
        throw createApiError("SERVICE_UNAVAILABLE");
      }
      throw error;
    }
  });
}
