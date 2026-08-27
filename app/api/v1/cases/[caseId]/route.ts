import { getCaseWorkspaceRuntime } from "@/modules/cases/server";
import { requireApiRequestAccessContext } from "@/app/api/v1/request-access";
import { createApiError, handleApiRequest, type JsonValue } from "@/modules/shared/public";

import { mapCaseWorkspaceDetailError } from "../route-contract.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { readonly params: Promise<{ readonly caseId: string }> },
): Promise<Response> {
  return handleApiRequest(request, async () => {
    const { caseId } = await context.params;
    try {
      const actor = await requireApiRequestAccessContext();
      const record = await getCaseWorkspaceRuntime().service.findCase(actor, caseId);
      if (!record) throw createApiError("NOT_FOUND");
      return { case: { ...record } } satisfies JsonValue;
    } catch (error) {
      throw mapCaseWorkspaceDetailError(error);
    }
  });
}
