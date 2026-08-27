import { requireApiRequestAccessContext } from "@/app/api/v1/request-access";
import { getCaseWorkspaceRuntime } from "@/modules/cases/server";
import { handleApiRequest, type JsonValue } from "@/modules/shared/public";

import {
  caseIntakeReceiptData,
  mapCaseIntakeError,
  parseCaseIntakeRequest,
} from "./intake-route-contract.ts";
import { mapCaseWorkspaceCollectionError } from "./route-contract.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handleApiRequest(request, async () => {
    try {
      const actor = await requireApiRequestAccessContext();
      const cases = await getCaseWorkspaceRuntime().service.listCases(actor);
      return { cases: cases.map((record) => ({ ...record })) } satisfies JsonValue;
    } catch (error) {
      throw mapCaseWorkspaceCollectionError(error);
    }
  });
}

export async function POST(request: Request): Promise<Response> {
  return handleApiRequest(request, async (context) => {
    try {
      const command = await parseCaseIntakeRequest(request, context.requestId);
      const actor = await requireApiRequestAccessContext();
      const created = await getCaseWorkspaceRuntime().intakeService.createCase({ actor, command });
      return caseIntakeReceiptData(created) satisfies JsonValue;
    } catch (error) {
      throw mapCaseIntakeError(error);
    }
  });
}
