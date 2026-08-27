import { getGuardianRelationshipRuntime } from "@/modules/crm/server";
import { requireApiRequestAccessContext } from "@/app/api/v1/request-access";
import {
  createRequestContext,
  errorResponse,
  handleApiRequest,
  successResponse,
} from "@/modules/shared/public";

import {
  mapGuardianRelationshipError,
  parseAttachCommand,
  toCurrentRelationshipsData,
  toRelationshipData,
} from "./handler.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: RouteContext<"/api/v1/students/[studentId]/guardians">,
): Promise<Response> {
  return handleApiRequest(request, async () => {
    try {
      const { studentId } = await context.params;
      const actor = await requireApiRequestAccessContext();
      return toCurrentRelationshipsData(
        await getGuardianRelationshipRuntime().service.listCurrent(actor, studentId),
      );
    } catch (error) {
      throw mapGuardianRelationshipError(error);
    }
  });
}

export async function POST(
  request: Request,
  context: RouteContext<"/api/v1/students/[studentId]/guardians">,
): Promise<Response> {
  const requestContext = createRequestContext(request);
  try {
    const { studentId } = await context.params;
    const command = await parseAttachCommand(request, studentId, requestContext.requestId);
    const actor = await requireApiRequestAccessContext();
    const relationship = await getGuardianRelationshipRuntime().service.attachGuardian({ actor, command });
    return successResponse(requestContext, { relationship: toRelationshipData(relationship) }, 201);
  } catch (error) {
    return errorResponse(requestContext, mapGuardianRelationshipError(error));
  }
}
