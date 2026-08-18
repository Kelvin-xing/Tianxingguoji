import { getCaseWorkspaceRuntime } from "@/modules/cases/server";
import { requireIdentityActor } from "@/modules/identity/web";
import { createApiError, handleApiRequest } from "@/modules/shared/public";
import {
  assertAssessmentCaseId,
  mapAssessmentError,
  requireAssessmentIdempotencyKey,
} from "../route-support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  readonly params: Promise<{ readonly caseId: string }>;
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  return handleApiRequest(request, async (requestContext) => {
    try {
      const { caseId } = await context.params;
      assertAssessmentCaseId(caseId);
      const idempotencyKey = requireAssessmentIdempotencyKey(request);
      const expectedRecordVersion = await parseExpectedRecordVersion(request);
      const actor = await requireIdentityActor();
      const result = await getCaseWorkspaceRuntime().assessmentService.completeBackgroundCollection({
        actor,
        caseId,
        command: {
          expectedRecordVersion,
          requestId: requestContext.requestId,
          idempotencyKey,
        },
      });
      return {
        assessment_id: result.assessmentId,
        status: result.status,
        record_version: result.recordVersion,
      };
    } catch (error) {
      throw mapAssessmentError(error);
    }
  });
}

async function parseExpectedRecordVersion(request: Request): Promise<number> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw createApiError("INVALID_REQUEST");
  }
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    typeof (body as Record<string, unknown>).expected_record_version !== "number"
  ) {
    throw createApiError("VALIDATION_FAILED");
  }
  return (body as Record<string, number>).expected_record_version;
}
