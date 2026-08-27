import { getGuardianRelationshipRuntime } from "@/modules/crm/server";
import { requireApiRequestAccessContext } from "@/app/api/v1/request-access";
import { handleApiRequest } from "@/modules/shared/public";

import {
  mapGuardianRelationshipError,
  parseHandoffCommand,
  toHandoffData,
} from "../handler.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: RouteContext<"/api/v1/students/[studentId]/guardians/primary-handoffs">,
): Promise<Response> {
  return handleApiRequest(request, async (requestContext) => {
    try {
      const { studentId } = await context.params;
      const command = await parseHandoffCommand(request, studentId, requestContext.requestId);
      const actor = await requireApiRequestAccessContext();
      return toHandoffData(
        await getGuardianRelationshipRuntime().service.handoffPrimaryContact({ actor, command }),
      );
    } catch (error) {
      throw mapGuardianRelationshipError(error);
    }
  });
}
