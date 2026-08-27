import { requireApiRequestAccessContext } from "@/app/api/v1/request-access";
import { getCaseWorkspaceRuntime } from "@/modules/cases/server";
import { createApiError, handleApiRequest } from "@/modules/shared/public";
import {
  assertCandidateListId,
  mapCandidateListError,
  readExactJson,
  requireCandidateListIdempotencyKey,
} from "./route-support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const BODY_FIELDS = ["change_summary","expected_case_record_version","items","previous_version_id"] as const;
const ITEM_FIELDS = ["ordinal","pinned_resolution_sha256","pinned_resolved_revision_id","school_id"] as const;

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
            typeof item.ordinal !== "number") throw createApiError("VALIDATION_FAILED");
        return { schoolId: item.school_id,
          pinnedResolvedRevisionId: item.pinned_resolved_revision_id,
          pinnedResolutionSha256: item.pinned_resolution_sha256, ordinal: item.ordinal };
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
