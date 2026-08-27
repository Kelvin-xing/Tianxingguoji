import { cookies } from "next/headers";

import {
  isRequestAccessContextError,
  resolveRequestAccessContext,
} from "@/modules/access/server";
import { SESSION_COOKIE_NAME } from "@/modules/identity/server";
import { createApiError, handleApiRequest } from "@/modules/shared/public";
import { BOOTSTRAP_ACCESS_POLICY_VERSION } from "@/modules/access/public";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handleApiRequest(request, async () => {
    const secret = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
    if (!secret) throw createApiError("UNAUTHENTICATED");
    let accessContext;
    try {
      accessContext = await resolveRequestAccessContext({ cookieSecret: secret });
    } catch (error) {
      if (isRequestAccessContextError(error, "REQUEST_ACCESS_UNAUTHENTICATED")) {
        throw createApiError("UNAUTHENTICATED");
      }
      if (isRequestAccessContextError(error, "REQUEST_ACCESS_FORBIDDEN")) {
        throw createApiError("FORBIDDEN");
      }
      throw createApiError("SERVICE_UNAVAILABLE");
    }

    const compatibilityRole = accessContext.roles[0];
    if (!compatibilityRole) throw createApiError("FORBIDDEN");

    return {
      user_id: accessContext.userId,
      organization_id: accessContext.organizationId,
      // Compatibility only: authorization uses the request-time capability union below.
      role: compatibilityRole,
      policy_version: BOOTSTRAP_ACCESS_POLICY_VERSION,
      capabilities: accessContext.workspaceCapabilities,
    };
  });
}
