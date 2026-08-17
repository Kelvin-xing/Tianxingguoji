import { cookies } from "next/headers";

import { SESSION_COOKIE_NAME } from "@/modules/identity/server";
import { getIdentityRuntime, IdentityRuntimeUnavailable } from "@/modules/identity/server";
import { IdentityServiceError } from "@/modules/identity/server";
import {
  CaseDashboardAuthenticationError,
  createCaseDashboardGetHandler,
} from "@/modules/operations/server";
import { getCaseDashboardRuntime } from "@/modules/operations/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const defaultGet = createCaseDashboardGetHandler({
  getSessionSecret: async () => (await cookies()).get(SESSION_COOKIE_NAME)?.value ?? null,
  requireSession: async (cookieSecret) => {
    try {
      return await getIdentityRuntime().service.requireSession({
        cookieSecret,
        sensitiveAction: false,
      });
    } catch (error) {
      if (error instanceof IdentityServiceError) throw new CaseDashboardAuthenticationError();
      if (error instanceof IdentityRuntimeUnavailable) throw error;
      throw error;
    }
  },
  getDashboardService: () => getCaseDashboardRuntime().service,
});

export async function GET(request: Request): Promise<Response> {
  return defaultGet(request);
}
