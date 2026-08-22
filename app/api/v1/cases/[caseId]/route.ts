import { getCaseWorkspaceRuntime } from "@/modules/cases/server";
import { requireIdentityActor } from "@/modules/identity/web";
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
      const actor = await requireIdentityActor();
      const record = await getCaseWorkspaceRuntime().service.findCase(actor, caseId);
      if (!record) throw createApiError("NOT_FOUND");
      return { case: { ...record } } satisfies JsonValue;
    } catch (error) {
      throw mapCaseWorkspaceDetailError(error);
    }
  });
}
