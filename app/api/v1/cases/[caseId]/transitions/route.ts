import { evaluateBootstrapAuthorization } from "@/modules/access/public";
import { requireIdentityActor } from "@/modules/identity/web";
import { createApiError, handleApiRequest } from "@/modules/shared/public";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(
  request: Request,
  context: { readonly params: Promise<{ readonly caseId: string }> },
): Promise<Response> {
  return handleApiRequest(request, async () => {
    const actor = await requireIdentityActor();
    if (!evaluateBootstrapAuthorization(actor.role, {
      capability: "cases.workflow.manage",
    }).allowed) {
      throw createApiError("FORBIDDEN");
    }
    const { caseId } = await context.params;
    if (!UUID.test(caseId)) throw createApiError("VALIDATION_FAILED");
    throw createApiError("CONFLICT");
  });
}
