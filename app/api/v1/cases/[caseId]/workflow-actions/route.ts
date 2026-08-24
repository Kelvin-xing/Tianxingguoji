import { getCaseWorkspaceRuntime } from "@/modules/cases/server";
import { requireIdentityActor } from "@/modules/identity/web";
import { handleApiRequest } from "@/modules/shared/public";

import {
  assertWorkflowCaseId,
  mapCaseWorkflowError,
  parseCaseWorkflowActionRequest,
} from "./route-support.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { readonly params: Promise<{ readonly caseId: string }> },
): Promise<Response> {
  return handleApiRequest(request, async (requestContext) => {
    try {
      const { caseId } = await context.params;
      assertWorkflowCaseId(caseId);
      const command = await parseCaseWorkflowActionRequest(request, requestContext.requestId);
      const actor = await requireIdentityActor();
      const result = await getCaseWorkspaceRuntime().workflowService.applyWorkflowAction({
        actor,
        caseId,
        command,
      });
      return { id: result.id, record_version: result.recordVersion };
    } catch (error) {
      throw mapCaseWorkflowError(error);
    }
  });
}
