import { evaluateBootstrapAuthorization } from "@/modules/access/public";
import { requireIdentityActor } from "@/modules/identity/web";
import { createApiError, handleApiRequest } from "@/modules/shared/public";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handleApiRequest(request, async () => {
    const actor = await requireIdentityActor();
    if (!evaluateBootstrapAuthorization(actor.role, { capability: "cases.create" }).allowed) {
      throw createApiError("FORBIDDEN");
    }
    throw createApiError("CONFLICT");
  });
}
