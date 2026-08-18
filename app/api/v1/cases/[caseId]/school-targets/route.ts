import { cookies } from "next/headers";

import {
  SchoolTargetError,
  SchoolTargetRuntimeUnavailable,
  getSchoolTargetRuntime,
  type SchoolTargetItem,
} from "@/modules/cases/server";
import {
  IdentityRuntimeUnavailable,
  IdentityServiceError,
  SESSION_COOKIE_NAME,
  getIdentityRuntime,
} from "@/modules/identity/server";
import { requireIdentityActor } from "@/modules/identity/web";
import {
  ApiContractError,
  createApiError,
  handleApiRequest,
} from "@/modules/shared/public";
import { parseCreateSchoolTargetRequest } from "./route-contract.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { readonly params: Promise<{ readonly caseId: string }> },
): Promise<Response> {
  return handleApiRequest(request, async () => {
    try {
      const { caseId } = await context.params;
      if (!UUID.test(caseId)) throw createApiError("INVALID_REQUEST");
      const actor = await requireIdentityActor();
      const result = await getSchoolTargetRuntime().service.getSchoolTargets({ actor, caseId });
      return {
        case_id: result.caseId,
        case_stage: result.caseStage,
        intake_year: result.intakeYear,
        admission_type: result.admissionType,
        can_create: result.canCreate,
        create_blocked_reason: result.createBlockedReason,
        items: result.items.map(toApiItem),
        school_options: result.schoolOptions.map((option) => ({
          school_id: option.schoolId,
          display_name: option.displayName,
          resolution_sha256: option.resolutionSha256,
        })),
      };
    } catch (error) {
      throw mapSchoolTargetError(error);
    }
  });
}

export async function POST(
  request: Request,
  context: { readonly params: Promise<{ readonly caseId: string }> },
): Promise<Response> {
  return handleApiRequest(request, async (requestContext) => {
    try {
      const { caseId } = await context.params;
      if (!UUID.test(caseId)) throw createApiError("INVALID_REQUEST");
      const parsed = await parseCreateSchoolTargetRequest(request, requestContext.requestId);
      const cookieSecret = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
      if (!cookieSecret) throw createApiError("UNAUTHENTICATED");
      const actor = await getIdentityRuntime().service.requireSession({
        cookieSecret,
        sensitiveAction: true,
      });
      const item = await getSchoolTargetRuntime().service.createSchoolTarget({
        actor,
        caseId,
        schoolId: parsed.schoolId,
        command: parsed.command,
      });
      return { case_id: caseId, item: toApiItem(item) };
    } catch (error) {
      throw mapSchoolTargetError(error);
    }
  });
}

function toApiItem(item: SchoolTargetItem) {
  return {
    target_id: item.targetId,
    school_id: item.schoolId,
    school_name: item.schoolName,
    state: item.state,
    intake_year: item.intakeYear,
    admission_type: item.admissionType,
    record_version: item.recordVersion,
    resolved_revision_id: item.resolvedRevisionId,
    resolution_sha256: item.resolutionSha256,
    created_at: item.createdAt,
  };
}

function mapSchoolTargetError(error: unknown): ApiContractError {
  if (error instanceof ApiContractError) return error;
  if (error instanceof IdentityRuntimeUnavailable || error instanceof SchoolTargetRuntimeUnavailable) {
    return createApiError("SERVICE_UNAVAILABLE");
  }
  if (error instanceof IdentityServiceError) return createApiError("UNAUTHENTICATED");
  if (!(error instanceof SchoolTargetError)) return createApiError("SERVICE_UNAVAILABLE");

  switch (error.code) {
    case "SCHOOL_TARGET_INVALID":
      return createApiError("VALIDATION_FAILED");
    case "SCHOOL_TARGET_READ_FORBIDDEN":
    case "SCHOOL_TARGET_ADVISOR_REQUIRED":
    case "SCHOOL_TARGET_CASE_FORBIDDEN":
      return createApiError("FORBIDDEN");
    case "SCHOOL_TARGET_CASE_NOT_FOUND":
    case "SCHOOL_TARGET_RESOLUTION_NOT_FOUND":
      return createApiError("NOT_FOUND");
    case "SCHOOL_TARGET_RESOLUTION_STALE":
      return createApiError("STALE_VERSION");
    case "SCHOOL_TARGET_STAGE_NOT_ALLOWED":
    case "SCHOOL_TARGET_IDEMPOTENCY_KEY_REUSED":
    case "SCHOOL_TARGET_IDEMPOTENCY_IN_PROGRESS":
    case "SCHOOL_TARGET_DUPLICATE":
      return createApiError("CONFLICT");
    case "SCHOOL_TARGET_RESOLUTION_INVALID":
      return createApiError("SERVICE_UNAVAILABLE");
  }
}
