import { getProfileMaintenanceRuntime, getStudentReadRuntime, GuardianRelationshipRuntimeUnavailable, StudentReadError } from "@/modules/crm/server";
import { requireIdentityActor } from "@/modules/identity/web";
import { createApiError, createRequestContext, errorResponse, handleApiRequest, successResponse, type JsonValue } from "@/modules/shared/public";
import { assertProfileMaintenanceCapability, mapProfileMaintenanceError, parseStudentProfileUpdate, toProfileAcknowledgement } from "../../profile-maintenance-handler.ts";

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

export async function PATCH(
  request: Request,
  context: { readonly params: Promise<{ readonly studentId: string }> },
): Promise<Response> {
  const requestContext = createRequestContext(request);
  try {
    const { studentId } = await context.params;
    const command = await parseStudentProfileUpdate(request, studentId, requestContext.requestId);
    const actor = await requireIdentityActor();
    assertProfileMaintenanceCapability(actor);
    const acknowledgement = await getProfileMaintenanceRuntime().service.updateStudent({ actor, command });
    return successResponse(requestContext, { student: toProfileAcknowledgement(acknowledgement) });
  } catch (error) {
    return errorResponse(requestContext, mapProfileMaintenanceError(error));
  }
}
