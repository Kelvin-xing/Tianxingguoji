import { requireApiRequestAccessContext } from "@/app/api/v1/request-access";
import { getCaseWorkspaceRuntime } from "@/modules/cases/server";
import { handleApiRequest, type JsonValue } from "@/modules/shared/public";

import {
  caseIntakeOptionsData,
  mapCaseIntakeError,
  parseCaseIntakeOptions,
} from "../intake-route-contract.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handleApiRequest(request, async () => {
    try {
      const actor = await requireApiRequestAccessContext();
      const filters = parseCaseIntakeOptions(request);
      const options = await getCaseWorkspaceRuntime().intakeService.listIntakeOptions(actor, filters);
      return caseIntakeOptionsData(options) satisfies JsonValue;
    } catch (error) {
      throw mapCaseIntakeError(error);
    }
  });
}
