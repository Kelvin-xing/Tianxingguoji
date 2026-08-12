import { cookies } from "next/headers";

import { SESSION_COOKIE_NAME } from "@/lib/auth/cookies";
import {
  SchoolServiceError,
  type SubmitSchoolChangeCommand,
} from "@/modules/schools/service";
import { SchoolRuntimeUnavailable, getSchoolRuntime } from "@/modules/schools/runtime";
import { IdentityRuntimeUnavailable, getIdentityRuntime } from "@/modules/identity/runtime";
import { IdentityServiceError } from "@/modules/identity/service";
import { createApiError, handleApiRequest } from "@/modules/shared/api-contract";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { readonly params: Promise<{ readonly schoolId: string }> },
): Promise<Response> {
  return handleApiRequest(request, async (requestContext) => {
    const { schoolId } = await context.params;
    if (!UUID.test(schoolId)) throw createApiError("INVALID_REQUEST");
    const command = await parseChangeCommand(request, requestContext.requestId);
    const cookieSecret = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
    if (!cookieSecret) throw createApiError("UNAUTHENTICATED");

    try {
      const actor = await getIdentityRuntime().service.requireSession({
        cookieSecret,
        sensitiveAction: true,
      });
      const result = await getSchoolRuntime().service.submitSchoolChange({
        actor,
        schoolId,
        command,
      });
      return {
        change_request_id: result.changeRequestId,
        school_id: result.schoolId,
        base_snapshot_id: result.baseSnapshotId,
        field_name: result.fieldName,
        status: result.status,
        record_version: result.recordVersion,
      };
    } catch (error) {
      throw mapSchoolError(error);
    }
  });
}

async function parseChangeCommand(
  request: Request,
  requestId: string,
): Promise<SubmitSchoolChangeCommand> {
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
  if (!isRecord(body) || !isRecord(body.evidence)) throw createApiError("INVALID_REQUEST");

  const fieldName = body.field_name;
  const fieldClass = body.field_class;
  const baseSnapshotId = body.base_snapshot_id;
  const baseValueSha256 = body.base_value_sha256;
  const proposedValue = body.proposed_value;
  const reason = body.reason;
  const sourceUrl = body.evidence.source_url;
  const quote = body.evidence.quote;
  if (
    typeof fieldName !== "string" ||
    typeof fieldClass !== "string" ||
    typeof baseSnapshotId !== "string" ||
    typeof baseValueSha256 !== "string" ||
    typeof reason !== "string" ||
    typeof sourceUrl !== "string" ||
    typeof quote !== "string"
  ) {
    throw createApiError("VALIDATION_FAILED");
  }

  return {
    fieldName,
    fieldClass: fieldClass as SubmitSchoolChangeCommand["fieldClass"],
    baseSnapshotId,
    baseValueSha256,
    proposedValue,
    reason,
    evidence: { sourceUrl, quote },
    requestId,
    idempotencyKey,
  };
}

function mapSchoolError(error: unknown) {
  if (error instanceof IdentityRuntimeUnavailable || error instanceof SchoolRuntimeUnavailable) {
    return createApiError("SERVICE_UNAVAILABLE");
  }
  if (error instanceof IdentityServiceError) return createApiError("UNAUTHENTICATED");
  if (!(error instanceof SchoolServiceError)) return createApiError("SERVICE_UNAVAILABLE");

  switch (error.code) {
    case "SCHOOL_ADVISOR_REQUIRED":
      return createApiError("FORBIDDEN");
    case "SCHOOL_COMMAND_INVALID":
      return createApiError("VALIDATION_FAILED");
    case "SCHOOL_CHANGE_BASE_NOT_FOUND":
      return createApiError("NOT_FOUND");
    case "SCHOOL_CHANGE_BASE_STALE":
    case "SCHOOL_CHANGE_IDEMPOTENCY_KEY_REUSED":
    case "SCHOOL_CHANGE_IDEMPOTENCY_IN_PROGRESS":
      return createApiError("CONFLICT");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
