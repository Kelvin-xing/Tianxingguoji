import { cookies } from "next/headers";

import { SESSION_COOKIE_NAME } from "@/modules/identity/server";
import {
  ResolvedSchoolViewRuntimeUnavailable,
  getResolvedSchoolViewRuntime,
} from "@/modules/schools/server";
import {
  SchoolResolutionError,
  type DisableSchoolOverlayCommand,
} from "@/modules/schools/server";
import { IdentityRuntimeUnavailable, getIdentityRuntime } from "@/modules/identity/server";
import { IdentityServiceError } from "@/modules/identity/server";
import { createApiError, handleApiRequest } from "@/modules/shared/public";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: {
    readonly params: Promise<{ readonly schoolId: string; readonly overlayRevisionId: string }>;
  },
): Promise<Response> {
  return handleApiRequest(request, async (requestContext) => {
    const { schoolId, overlayRevisionId } = await context.params;
    if (!UUID.test(schoolId) || !UUID.test(overlayRevisionId)) {
      throw createApiError("INVALID_REQUEST");
    }
    const command = await parseDisableCommand(request, requestContext.requestId);
    const cookieSecret = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
    if (!cookieSecret) throw createApiError("UNAUTHENTICATED");

    try {
      const actor = await getIdentityRuntime().service.requireSession({
        cookieSecret,
        sensitiveAction: true,
      });
      const result = await getResolvedSchoolViewRuntime().service.disableApprovedOverlay({
        actor,
        schoolId,
        overlayRevisionId,
        command,
      });
      return {
        overlay_revision_id: result.overlayRevisionId,
        record_version: result.recordVersion,
        rollback: {
          resolved_revision_id: result.rollback.pin.resolvedRevisionId,
          base_snapshot_id: result.rollback.pin.baseSnapshotId,
          overlay_revision_id: result.rollback.pin.overlayRevisionId,
          resolution_sha256: result.rollback.pin.resolutionSha256,
        },
      };
    } catch (error) {
      throw mapSchoolResolutionError(error);
    }
  });
}

async function parseDisableCommand(
  request: Request,
  requestId: string,
): Promise<DisableSchoolOverlayCommand> {
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
  const expectedRecordVersion = body.expected_record_version;
  const reason = body.reason;
  if (typeof expectedRecordVersion !== "number" || typeof reason !== "string") {
    throw createApiError("VALIDATION_FAILED");
  }
  return { expectedRecordVersion, reason, requestId, idempotencyKey };
}

function mapSchoolResolutionError(error: unknown) {
  if (
    error instanceof IdentityRuntimeUnavailable ||
    error instanceof ResolvedSchoolViewRuntimeUnavailable
  ) {
    return createApiError("SERVICE_UNAVAILABLE");
  }
  if (error instanceof IdentityServiceError) return createApiError("UNAUTHENTICATED");
  if (!(error instanceof SchoolResolutionError)) return createApiError("SERVICE_UNAVAILABLE");

  switch (error.code) {
    case "SCHOOL_RESOLUTION_INVALID":
      return createApiError("VALIDATION_FAILED");
    case "SCHOOL_RESOLUTION_NOT_FOUND":
      return createApiError("NOT_FOUND");
    case "SCHOOL_RESOLUTION_FORBIDDEN":
    case "SCHOOL_OVERLAY_REVIEWER_REQUIRED":
    case "SCHOOL_OVERLAY_SELF_REVIEW_DENIED":
      return createApiError("FORBIDDEN");
    case "SCHOOL_OVERLAY_NOT_APPROVED":
    case "SCHOOL_OVERLAY_IDEMPOTENCY_KEY_REUSED":
    case "SCHOOL_OVERLAY_IDEMPOTENCY_IN_PROGRESS":
      return createApiError("CONFLICT");
    case "SCHOOL_OVERLAY_STALE_VERSION":
      return createApiError("STALE_VERSION");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
