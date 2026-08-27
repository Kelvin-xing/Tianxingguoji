import { getGuardianRelationshipRuntime } from "@/modules/crm/server";
import { requireApiRequestAccessContext } from "@/app/api/v1/request-access";
import { createRequestContext, errorResponse, handleApiRequest, successResponse } from "@/modules/shared/public";
import { mapGuardianRelationshipError, parseEndCommand, toEndData } from "@/app/api/v1/students/[studentId]/guardians/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: {
  readonly params: Promise<{ readonly studentId: string; readonly relationshipId: string }>;
}): Promise<Response> {
  const requestContext = createRequestContext(request);
  try {
    const { studentId, relationshipId } = await context.params;
    const command = await parseEndCommand(request, studentId, relationshipId, requestContext.requestId);
    const actor = await requireApiRequestAccessContext();
    const result = await getGuardianRelationshipRuntime().service.endRelationship({ actor, command });
    return successResponse(requestContext, toEndData(result));
  } catch (error) {
    return errorResponse(requestContext, mapGuardianRelationshipError(error));
  }
}
