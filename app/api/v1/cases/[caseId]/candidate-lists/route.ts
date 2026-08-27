import { requireApiRequestAccessContext } from "@/app/api/v1/request-access";
import { getCaseWorkspaceRuntime } from "@/modules/cases/server";
import { createApiError, handleApiRequest } from "@/modules/shared/public";
import {
  assertCandidateListId,
  mapCandidateListError,
  parseCandidateListQuery,
  readExactJson,
  requireCandidateListIdempotencyKey,
} from "./route-support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const BODY_FIELDS = ["change_summary","expected_case_record_version","items","previous_version_id"] as const;
const ITEM_FIELDS = ["application_deadline","ordinal","pinned_resolution_sha256",
  "pinned_resolved_revision_id","school_id"] as const;

export async function GET(request: Request, context: {
  readonly params: Promise<{ readonly caseId: string }>;
}): Promise<Response> {
  return handleApiRequest(request, async (requestContext) => {
    try {
      const { caseId } = await context.params;
      assertCandidateListId(caseId);
      const query = parseCandidateListQuery(request);
      const actor = await requireApiRequestAccessContext();
      const result = await getCaseWorkspaceRuntime().candidateListQueryService.list({
        actor, caseId, requestId: requestContext.requestId,
        limit: query.limit, cursor: query.cursor,
      });
      return {
        items: result.items.map((version) => ({
          id: version.id,
          version_number: version.versionNumber,
          previous_version_id: version.previousVersionId,
          school_set_sha256: version.schoolSetSha256,
          status: version.status,
          record_version: version.recordVersion,
          change_summary: version.changeSummary,
          created_by_user_id: version.createdByUserId,
          created_at: version.createdAt,
          submitted_at: version.submittedAt,
          items: version.items.map((item) => ({
            id: item.id,
            school_id: item.schoolId,
            pinned_resolved_revision_id: item.pinnedResolvedRevisionId,
            pinned_resolution_sha256: item.pinnedResolutionSha256,
            ordinal: item.ordinal,
            school_target_id: item.schoolTargetId,
            application_deadline: item.applicationDeadline,
          })),
          founder_approval: version.founderApproval === null ? null : {
            decision: version.founderApproval.decision,
            decided_by_user_id: version.founderApproval.decidedByUserId,
            decided_at: version.founderApproval.decidedAt,
            reason: version.founderApproval.reason,
            decision_sha256: version.founderApproval.decisionSha256,
          },
          guardian_decision: version.guardianDecision === null ? null : {
            guardian_id: version.guardianDecision.guardianId,
            guardian_relationship_id: version.guardianDecision.guardianRelationshipId,
            decision: version.guardianDecision.decision,
            decided_at: version.guardianDecision.decidedAt,
            channel: version.guardianDecision.channel,
            recorded_by_user_id: version.guardianDecision.recordedByUserId,
            recorded_at: version.guardianDecision.recordedAt,
            bound_founder_decision_sha256: version.guardianDecision.boundFounderDecisionSha256,
          },
        })),
        next_cursor: result.nextCursor,
      };
    } catch (error) { throw mapCandidateListError(error); }
  });
}

export async function POST(request: Request, context: {
  readonly params: Promise<{ readonly caseId: string }>;
}): Promise<Response> {
  return handleApiRequest(request, async (requestContext) => {
    try {
      const { caseId } = await context.params;
      assertCandidateListId(caseId);
      const idempotencyKey = requireCandidateListIdempotencyKey(request);
      const body = await readExactJson(request, BODY_FIELDS);
      if (typeof body.expected_case_record_version !== "number" ||
          typeof body.change_summary !== "string" ||
          (body.previous_version_id !== null && typeof body.previous_version_id !== "string") ||
          !Array.isArray(body.items)) throw createApiError("VALIDATION_FAILED");
      const items = body.items.map((value) => {
        if (typeof value !== "object" || value === null || Array.isArray(value) ||
            Object.keys(value).sort().join(",") !== [...ITEM_FIELDS].sort().join(",")) {
          throw createApiError("VALIDATION_FAILED");
        }
        const item = value as Record<(typeof ITEM_FIELDS)[number], unknown>;
        if (typeof item.school_id !== "string" ||
            typeof item.pinned_resolved_revision_id !== "string" ||
            typeof item.pinned_resolution_sha256 !== "string" ||
            typeof item.ordinal !== "number" ||
            typeof item.application_deadline !== "string") {
          throw createApiError("VALIDATION_FAILED");
        }
        return { schoolId: item.school_id,
          pinnedResolvedRevisionId: item.pinned_resolved_revision_id,
          pinnedResolutionSha256: item.pinned_resolution_sha256, ordinal: item.ordinal,
          applicationDeadline: item.application_deadline };
      });
      const actor = await requireApiRequestAccessContext();
      const result = await getCaseWorkspaceRuntime().candidateListService.createVersion({
        actor, caseId, previousVersionId: body.previous_version_id,
        expectedCaseRecordVersion: body.expected_case_record_version,
        changeSummary: body.change_summary, items, requestId: requestContext.requestId,
        idempotencyKey,
      });
      return { id: result.id, record_version: result.recordVersion };
    } catch (error) { throw mapCandidateListError(error); }
  });
}
