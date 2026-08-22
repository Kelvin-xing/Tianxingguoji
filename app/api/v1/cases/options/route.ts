import { getCaseWorkspaceRuntime } from "@/modules/cases/server";
import { requireIdentityActor } from "@/modules/identity/web";
import { handleApiRequest, type JsonValue } from "@/modules/shared/public";

import { mapCaseWorkspaceCollectionError } from "../route-contract.ts";

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
      throw mapCaseWorkspaceCollectionError(error);
    }
  });
}
