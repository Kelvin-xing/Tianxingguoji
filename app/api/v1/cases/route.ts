import { evaluateBootstrapAuthorization } from "@/modules/access/public";
import { getCaseWorkspaceRuntime } from "@/modules/cases/server";
import { requireIdentityActor } from "@/modules/identity/web";
import { createApiError, handleApiRequest, type JsonValue } from "@/modules/shared/public";

import { mapCaseWorkspaceCollectionError, parseCaseCreateRequest } from "./route-contract.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handleApiRequest(request, async () => {
    try {
      const actor = await requireIdentityActor();
      const cases = await getCaseWorkspaceRuntime().service.listCases(actor);
      return { cases: cases.map((record) => ({ ...record })) } satisfies JsonValue;
    } catch (error) {
      throw mapCaseWorkspaceCollectionError(error);
    }
  });
}

export async function POST(request: Request): Promise<Response> {
  return handleApiRequest(request, async (context) => {
    const command = await parseCaseCreateRequest(request, context.requestId);
    try {
      const actor = await requireIdentityActor();
      if (!evaluateBootstrapAuthorization(actor.role, { capability: "cases.create" }).allowed) {
        throw createApiError("FORBIDDEN");
      }
      const created = await getCaseWorkspaceRuntime().service.createCase({ actor, command });
      return {
        id: created.id,
        record_version: created.recordVersion,
      } satisfies JsonValue;
    } catch (error) {
      throw mapCaseWorkspaceCollectionError(error);
    }
  });
}
