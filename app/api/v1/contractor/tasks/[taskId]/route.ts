import { cookies } from "next/headers";

import { SESSION_COOKIE_NAME } from "../../../../../../lib/auth/cookies.ts";
import { getIdentityRuntime } from "../../../../../../modules/identity/runtime.ts";
import {
  createContractorTaskGetHandler,
  type ContractorTaskGetContext,
} from "../../../../../../modules/tasks/contractor-route.ts";
import {
  getContractorTaskWorkspaceRuntime,
} from "../../../../../../modules/tasks/contractor-workspace-runtime.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const defaultGet = createContractorTaskGetHandler({
  getSessionSecret: async () => (await cookies()).get(SESSION_COOKIE_NAME)?.value ?? null,
  requireSession: async (cookieSecret) =>
    getIdentityRuntime().service.requireSession({ cookieSecret, sensitiveAction: false }),
  getWorkspaceService: () => getContractorTaskWorkspaceRuntime().service,
});

export async function GET(request: Request, context: ContractorTaskGetContext): Promise<Response> {
  return defaultGet(request, context);
}
