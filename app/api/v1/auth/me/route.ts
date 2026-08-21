import { cookies } from "next/headers";

import { SESSION_COOKIE_NAME } from "@/modules/identity/server";
import { handleApiRequest } from "@/modules/shared/public";
import { IdentityRuntimeUnavailable, getIdentityRuntime } from "@/modules/identity/server";
import { isIdentityServiceError } from "@/modules/identity/server";
import { createApiError } from "@/modules/shared/public";
import { workspaceCapabilitiesForRole } from "@/modules/access/public";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handleApiRequest(request, async () => {
    const secret = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
    if (!secret) throw createApiError("UNAUTHENTICATED");
    try {
      const actor = await getIdentityRuntime().service.requireSession({
        cookieSecret: secret,
        sensitiveAction: false,
      });
      return {
        user_id: actor.userId,
        organization_id: actor.organizationId,
        role: actor.role,
        capabilities: workspaceCapabilitiesForRole(actor.role),
      };
    } catch (error) {
      if (isIdentityServiceError(error, "SESSION_NOT_FOUND")) {
        throw createApiError("UNAUTHENTICATED");
      }
      if (error instanceof IdentityRuntimeUnavailable) throw createApiError("SERVICE_UNAVAILABLE");
      throw createApiError("SERVICE_UNAVAILABLE");
    }
  });
}
