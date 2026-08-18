import { CaseRuntimeUnavailable, CaseWorkspaceError, getCaseWorkspaceRuntime } from "@/modules/cases/server";
import { requireIdentityActor } from "@/modules/identity/web";
import { createApiError, handleApiRequest, type JsonValue } from "@/modules/shared/public";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handleApiRequest(request, async () => {
    try {
      const actor = await requireIdentityActor();
      const options = await getCaseWorkspaceRuntime().service.listOptions(actor);
      return {
        options: {
          students: options.students.map((student) => ({ ...student })),
          primaryBindings: options.primaryBindings.map((binding) => ({ ...binding })),
          manifests: options.manifests.map((manifest) => ({ ...manifest })),
        },
      } satisfies JsonValue;
    } catch (error) {
      if (error instanceof CaseWorkspaceError && error.code === "CASE_WORKSPACE_FORBIDDEN") {
        throw createApiError("FORBIDDEN");
      }
      if (error instanceof CaseRuntimeUnavailable) throw createApiError("SERVICE_UNAVAILABLE");
      throw error;
    }
  });
}
