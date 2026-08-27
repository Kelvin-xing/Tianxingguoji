import { requireApiRequestAccessContext } from "@/app/api/v1/request-access";
import { getCaseWorkspaceRuntime } from "@/modules/cases/server";
import { getTaskWorkflowRuntime } from "@/modules/tasks/server";
import { createApiError, handleApiRequest } from "@/modules/shared/public";
import { assertCandidateListId,mapCandidateListError,readExactJson,
  requireCandidateListIdempotencyKey } from "../../route-support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const BODY_FIELDS = ["bound_founder_decision_sha256","channel","decision",
  "expected_case_record_version","expected_list_record_version","guardian_decided_at",
  "guardian_id","guardian_relationship_id"] as const;

export async function POST(request: Request, context: { readonly params: Promise<{
  readonly caseId: string; readonly versionId: string;
}> }): Promise<Response> {
  return handleApiRequest(request, async (requestContext) => {
    try {
      const { caseId,versionId } = await context.params;
      assertCandidateListId(caseId); assertCandidateListId(versionId);
      const idempotencyKey = requireCandidateListIdempotencyKey(request);
      const body = await readExactJson(request,BODY_FIELDS);
      if ((body.decision !== "confirmed" && body.decision !== "not_confirmed") ||
          (body.channel !== "phone" && body.channel !== "wechat" && body.channel !== "in_person") ||
          typeof body.expected_case_record_version !== "number" ||
          typeof body.expected_list_record_version !== "number" ||
          typeof body.guardian_decided_at !== "string" || typeof body.guardian_id !== "string" ||
          typeof body.guardian_relationship_id !== "string" ||
          typeof body.bound_founder_decision_sha256 !== "string") {
        throw createApiError("VALIDATION_FAILED");
      }
      const actor = await requireApiRequestAccessContext();
      const result = await getCaseWorkspaceRuntime().candidateListService.recordGuardianDecision({
        actor,caseId,versionId,expectedListRecordVersion: body.expected_list_record_version,
        expectedCaseRecordVersion: body.expected_case_record_version,
        guardianId: body.guardian_id,guardianRelationshipId: body.guardian_relationship_id,
        decision: body.decision,channel: body.channel,guardianDecidedAt: body.guardian_decided_at,
        boundFounderDecisionSha256: body.bound_founder_decision_sha256,
        requestId: requestContext.requestId,idempotencyKey,
      });
      const automation = body.decision === "confirmed"
        ? await drainApplicationTasks(actor.organizationId,caseId,versionId,requestContext.requestId)
        : { applicationTasks:"completed" as const,requestedCount:0,provisionedCount:0 };
      return { id: result.id,record_version: result.recordVersion,automation:{
        application_tasks:automation.applicationTasks,
        requested_count:automation.requestedCount,
        provisioned_count:automation.provisionedCount,
      } };
    } catch (error) { throw mapCandidateListError(error); }
  });
}

async function drainApplicationTasks(organizationId:string,caseId:string,versionId:string,
  requestId:string) {
  try {
    return await getTaskWorkflowRuntime().applicationTaskConsumer.drainForCandidateVersion({
      organizationId,caseId,versionId,requestId,
    });
  } catch {
    return { applicationTasks:"pending" as const,requestedCount:-1,provisionedCount:0 };
  }
}
