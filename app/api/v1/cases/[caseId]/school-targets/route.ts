import { cookies } from "next/headers";

import { SESSION_COOKIE_NAME } from "@/lib/auth/cookies";
import {
  SchoolTargetRuntimeUnavailable,
  getSchoolTargetRuntime,
} from "@/modules/cases/school-target-runtime";
import {
  SchoolTargetError,
  type CreateSchoolTargetCommand,
} from "@/modules/cases/school-target-service";
import { IdentityRuntimeUnavailable, getIdentityRuntime } from "@/modules/identity/runtime";
import { IdentityServiceError } from "@/modules/identity/service";
import { createApiError, handleApiRequest } from "@/modules/shared/api-contract";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { readonly params: Promise<{ readonly caseId: string }> },
): Promise<Response> {
  return handleApiRequest(request, async (requestContext) => {
    const { caseId } = await context.params;
    if (!UUID.test(caseId)) throw createApiError("INVALID_REQUEST");
    const parsed = await parseCreateCommand(request, requestContext.requestId);
    const cookieSecret = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
    if (!cookieSecret) throw createApiError("UNAUTHENTICATED");

    try {
      const actor = await getIdentityRuntime().service.requireSession({
        cookieSecret,
        sensitiveAction: true,
      });
      const result = await getSchoolTargetRuntime().service.createSchoolTarget({
        actor,
        caseId,
        schoolId: parsed.schoolId,
        command: parsed.command,
      });
      return {
        target_id: result.targetId,
        case_id: result.caseId,
        school_id: result.schoolId,
        state: result.state,
        record_version: result.recordVersion,
        pin: {
          resolved_revision_id: result.pin.resolvedRevisionId,
          base_snapshot_id: result.pin.baseSnapshotId,
          overlay_revision_id: result.pin.overlayRevisionId,
          resolution_sha256: result.pin.resolutionSha256,
        },
      };
    } catch (error) {
      throw mapSchoolTargetError(error);
    }
  });
}

async function parseCreateCommand(
  request: Request,
  requestId: string,
): Promise<{ readonly schoolId: string; readonly command: CreateSchoolTargetCommand }> {
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
    throw createApiError("INVALID_REQUEST");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw createApiError("INVALID_REQUEST");
  }
  if (!isRecord(body)) throw createApiError("INVALID_REQUEST");

  const schoolId = body.school_id;
  const intakeYear = body.intake_year;
  const admissionType = body.admission_type;
  const expectedResolutionSha256 = body.expected_resolution_sha256;
  if (
    typeof schoolId !== "string" ||
    typeof intakeYear !== "number" ||
    typeof admissionType !== "string" ||
    typeof expectedResolutionSha256 !== "string"
  ) {
    throw createApiError("VALIDATION_FAILED");
  }
  return {
    schoolId,
    command: { intakeYear, admissionType, expectedResolutionSha256, requestId, idempotencyKey },
  };
}

function mapSchoolTargetError(error: unknown) {
  if (error instanceof IdentityRuntimeUnavailable || error instanceof SchoolTargetRuntimeUnavailable) {
    return createApiError("SERVICE_UNAVAILABLE");
  }
  if (error instanceof IdentityServiceError) return createApiError("UNAUTHENTICATED");
  if (!(error instanceof SchoolTargetError)) return createApiError("SERVICE_UNAVAILABLE");

  switch (error.code) {
    case "SCHOOL_TARGET_INVALID":
      return createApiError("VALIDATION_FAILED");
    case "SCHOOL_TARGET_ADVISOR_REQUIRED":
    case "SCHOOL_TARGET_CASE_FORBIDDEN":
      return createApiError("FORBIDDEN");
    case "SCHOOL_TARGET_CASE_NOT_FOUND":
    case "SCHOOL_TARGET_RESOLUTION_NOT_FOUND":
      return createApiError("NOT_FOUND");
    case "SCHOOL_TARGET_RESOLUTION_STALE":
      return createApiError("STALE_VERSION");
    case "SCHOOL_TARGET_IDEMPOTENCY_KEY_REUSED":
    case "SCHOOL_TARGET_IDEMPOTENCY_IN_PROGRESS":
    case "SCHOOL_TARGET_DUPLICATE":
      return createApiError("CONFLICT");
    case "SCHOOL_TARGET_RESOLUTION_INVALID":
      return createApiError("SERVICE_UNAVAILABLE");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
