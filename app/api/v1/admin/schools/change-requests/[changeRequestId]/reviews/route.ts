import { cookies } from "next/headers";

import { SESSION_COOKIE_NAME } from "@/modules/identity/server";
import { IdentityRuntimeUnavailable, getIdentityRuntime } from "@/modules/identity/server";
import { IdentityServiceError } from "@/modules/identity/server";
import {
  SchoolGovernanceError,
  type ReviewSchoolChangeCommand,
} from "@/modules/schools/server";
import {
  SchoolGovernanceRuntimeUnavailable,
  getSchoolGovernanceRuntime,
} from "@/modules/schools/server";
import { createApiError, handleApiRequest } from "@/modules/shared/public";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { readonly params: Promise<{ readonly changeRequestId: string }> }): Promise<Response> {
  return handleApiRequest(request, async (requestContext) => {
    const { changeRequestId } = await context.params;
    if (!UUID.test(changeRequestId)) throw createApiError("INVALID_REQUEST");
    const command = await parseCommand(request, requestContext.requestId);
    const cookieSecret = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
    if (!cookieSecret) throw createApiError("UNAUTHENTICATED");
    try {
      const actor = await getIdentityRuntime().service.requireSession({ cookieSecret, sensitiveAction: true });
      const result = await getSchoolGovernanceRuntime().service.reviewChangeRequest({ actor, changeRequestId, command });
      return {
        change_request_id: result.changeRequestId,
        school_id: result.schoolId,
        overlay_revision_id: result.overlayRevisionId,
        resolved_revision_id: result.resolvedRevisionId,
        status: result.status,
        record_version: result.recordVersion,
      };
    } catch (error) {
      throw mapError(error);
    }
  });
}

async function parseCommand(request: Request, requestId: string): Promise<ReviewSchoolChangeCommand> {
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey || !IDEMPOTENCY_KEY.test(idempotencyKey)) throw createApiError("INVALID_REQUEST");
  let body: unknown;
  try { body = await request.json(); } catch { throw createApiError("INVALID_REQUEST"); }
  if (!isRecord(body)) throw createApiError("INVALID_REQUEST");
  if ((body.decision !== "approve" && body.decision !== "reject") || typeof body.expected_record_version !== "number" || typeof body.reason !== "string") {
    throw createApiError("VALIDATION_FAILED");
  }
  return { decision: body.decision, expectedRecordVersion: body.expected_record_version, reason: body.reason, requestId, idempotencyKey };
}

function mapError(error: unknown) {
  if (error instanceof IdentityRuntimeUnavailable || error instanceof SchoolGovernanceRuntimeUnavailable) return createApiError("SERVICE_UNAVAILABLE");
  if (error instanceof IdentityServiceError) return createApiError("UNAUTHENTICATED");
  if (!(error instanceof SchoolGovernanceError)) return createApiError("SERVICE_UNAVAILABLE");
  switch (error.code) {
    case "SCHOOL_GOVERNANCE_INVALID": return createApiError("VALIDATION_FAILED");
    case "SCHOOL_GOVERNANCE_REVIEWER_REQUIRED":
    case "SCHOOL_GOVERNANCE_SELF_REVIEW_DENIED":
    case "SCHOOL_GOVERNANCE_IDENTITY_REQUIRES_FOUNDER": return createApiError("FORBIDDEN");
    case "SCHOOL_GOVERNANCE_NOT_FOUND": return createApiError("NOT_FOUND");
    case "SCHOOL_GOVERNANCE_STALE_VERSION": return createApiError("STALE_VERSION");
    case "SCHOOL_GOVERNANCE_CONFLICT":
    case "SCHOOL_GOVERNANCE_IDEMPOTENCY_KEY_REUSED":
    case "SCHOOL_GOVERNANCE_IDEMPOTENCY_IN_PROGRESS": return createApiError("CONFLICT");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
