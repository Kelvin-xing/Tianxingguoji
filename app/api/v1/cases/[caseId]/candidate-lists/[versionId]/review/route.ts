import { requireApiRequestAccessContext } from "@/app/api/v1/request-access";
import { getCaseWorkspaceRuntime } from "@/modules/cases/server";
import { createApiError, handleApiRequest } from "@/modules/shared/public";
import { assertCandidateListId, mapCandidateListError, readExactJson,
  requireCandidateListIdempotencyKey } from "../../route-support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const BODY_FIELDS = ["decision","expected_record_version","reason"] as const;

export async function POST(request: Request, context: { readonly params: Promise<{
  readonly caseId: string; readonly versionId: string;
}> }): Promise<Response> {
  return handleApiRequest(request, async (requestContext) => {
    try {
      const { caseId,versionId } = await context.params;
      assertCandidateListId(caseId); assertCandidateListId(versionId);
      const idempotencyKey = requireCandidateListIdempotencyKey(request);
      const body = await readExactJson(request,BODY_FIELDS);
      if ((body.decision !== "approved" && body.decision !== "rejected") ||
          typeof body.expected_record_version !== "number" || typeof body.reason !== "string") {
        throw createApiError("VALIDATION_FAILED");
      }
      const actor = await requireApiRequestAccessContext();
      const result = await getCaseWorkspaceRuntime().candidateListService.reviewVersion({
        actor,caseId,versionId,expectedRecordVersion: body.expected_record_version,
        decision: body.decision,reason: body.reason,requestId: requestContext.requestId,
        idempotencyKey,
      });
      return { id: result.id,record_version: result.recordVersion,
        founder_decision_sha256: result.founderDecisionSha256 ?? null };
    } catch (error) { throw mapCandidateListError(error); }
  });
}
