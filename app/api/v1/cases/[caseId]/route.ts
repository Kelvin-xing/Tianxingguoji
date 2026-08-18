import { CaseRuntimeUnavailable, CaseWorkspaceError, getCaseWorkspaceRuntime } from "@/modules/cases/server";
import { requireIdentityActor } from "@/modules/identity/web";
import { createApiError, handleApiRequest, type JsonValue } from "@/modules/shared/public";

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
      if (error instanceof CaseWorkspaceError) {
        if (error.code === "CASE_WORKSPACE_FORBIDDEN") throw createApiError("FORBIDDEN");
        if (error.code === "CASE_WORKSPACE_INVALID") throw createApiError("NOT_FOUND");
      }
      if (error instanceof CaseRuntimeUnavailable) throw createApiError("SERVICE_UNAVAILABLE");
      throw error;
    }
  });
}
