import { evaluateBootstrapAuthorization, type WorkspaceCapability } from "@/modules/access/public";
import { requireIdentityActor } from "@/modules/identity/web";
import { createApiError, handleApiRequest } from "@/modules/shared/public";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return disabledCaseSurface(request, "cases.read");
}

export async function POST(request: Request): Promise<Response> {
  return disabledCaseSurface(request, "cases.create");
}

function disabledCaseSurface(
  request: Request,
  capability: WorkspaceCapability,
): Promise<Response> {
  return handleApiRequest(request, async () => {
    const actor = await requireIdentityActor();
    if (!evaluateBootstrapAuthorization(actor.role, { capability }).allowed) {
      throw createApiError("FORBIDDEN");
    }
    throw createApiError("CONFLICT");
  });
}
