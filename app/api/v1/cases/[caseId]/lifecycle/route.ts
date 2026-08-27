import { requireApiRequestAccessContext } from "@/app/api/v1/request-access";
import { getCaseWorkspaceRuntime } from "@/modules/cases/server";
import { createApiError,handleApiRequest } from "@/modules/shared/public";
import { assertCandidateListId,mapCandidateListError,readExactJson,
  requireCandidateListIdempotencyKey } from "../candidate-lists/route-support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const BODY_FIELDS = ["action","closure_outcome","expected_case_record_version","reason"] as const;

export async function POST(request: Request,context: { readonly params: Promise<{
  readonly caseId: string;
}> }): Promise<Response> {
  return handleApiRequest(request,async (requestContext) => {
    try {
      const { caseId } = await context.params;
      assertCandidateListId(caseId);
      const idempotencyKey = requireCandidateListIdempotencyKey(request);
      const body = await readExactJson(request,BODY_FIELDS);
      if (body.action !== "close" ||
          (body.closure_outcome !== "success" && body.closure_outcome !== "no_offer" &&
            body.closure_outcome !== "service_terminated") ||
          typeof body.expected_case_record_version !== "number" || typeof body.reason !== "string") {
        throw createApiError("VALIDATION_FAILED");
      }
      const actor = await requireApiRequestAccessContext();
      const result = await getCaseWorkspaceRuntime().candidateListService.closeCase({
        actor,caseId,expectedCaseRecordVersion: body.expected_case_record_version,
        closureOutcome: body.closure_outcome,reason: body.reason,
        requestId: requestContext.requestId,idempotencyKey,
      });
      return { id: result.id,record_version: result.recordVersion,status: "closed" };
    } catch (error) { throw mapCandidateListError(error); }
  });
}
