import { cookies } from "next/headers";

import { SESSION_COOKIE_NAME } from "@/lib/auth/cookies";
import { IdentityRuntimeUnavailable, getIdentityRuntime } from "@/modules/identity/runtime";
import { IdentityServiceError } from "@/modules/identity/service";
import { SchoolGovernanceError, type ReconcileSchoolOverlayCommand } from "@/modules/schools/governance-service";
import { SchoolGovernanceRuntimeUnavailable, getSchoolGovernanceRuntime } from "@/modules/schools/school-governance-runtime";
import { createApiError, handleApiRequest } from "@/modules/shared/api-contract";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { readonly params: Promise<{ readonly schoolId: string; readonly overlayRevisionId: string }> }): Promise<Response> {
  return handleApiRequest(request, async (requestContext) => {
    const { schoolId, overlayRevisionId } = await context.params;
    if (!UUID.test(schoolId) || !UUID.test(overlayRevisionId)) throw createApiError("INVALID_REQUEST");
    const command = await parseCommand(request, requestContext.requestId);
    const cookieSecret = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
    if (!cookieSecret) throw createApiError("UNAUTHENTICATED");
    try {
      const actor = await getIdentityRuntime().service.requireSession({ cookieSecret, sensitiveAction: true });
      const result = await getSchoolGovernanceRuntime().service.reconcileApprovedOverlay({ actor, schoolId, overlayRevisionId, command });
      return { school_id: result.schoolId, overlay_revision_id: result.overlayRevisionId, snapshot_id: result.snapshotId, action: result.action, resolved_revision_id: result.resolvedRevisionId, review_item_id: result.reviewItemId, record_version: result.recordVersion };
    } catch (error) { throw mapError(error); }
  });
}

async function parseCommand(request: Request, requestId: string): Promise<ReconcileSchoolOverlayCommand> {
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey || !IDEMPOTENCY_KEY.test(idempotencyKey)) throw createApiError("INVALID_REQUEST");
  let body: unknown;
  try { body = await request.json(); } catch { throw createApiError("INVALID_REQUEST"); }
  if (!isRecord(body)) throw createApiError("INVALID_REQUEST");
  if (typeof body.snapshot_id !== "string" || typeof body.expected_overlay_record_version !== "number") throw createApiError("VALIDATION_FAILED");
  return { snapshotId: body.snapshot_id, expectedOverlayRecordVersion: body.expected_overlay_record_version, requestId, idempotencyKey };
}

function mapError(error: unknown) {
  if (error instanceof IdentityRuntimeUnavailable || error instanceof SchoolGovernanceRuntimeUnavailable) return createApiError("SERVICE_UNAVAILABLE");
  if (error instanceof IdentityServiceError) return createApiError("UNAUTHENTICATED");
  if (!(error instanceof SchoolGovernanceError)) return createApiError("SERVICE_UNAVAILABLE");
  if (error.code === "SCHOOL_GOVERNANCE_INVALID") return createApiError("VALIDATION_FAILED");
  if (error.code === "SCHOOL_GOVERNANCE_NOT_FOUND") return createApiError("NOT_FOUND");
  if (error.code === "SCHOOL_GOVERNANCE_STALE_VERSION") return createApiError("STALE_VERSION");
  if (["SCHOOL_GOVERNANCE_REVIEWER_REQUIRED", "SCHOOL_GOVERNANCE_SELF_REVIEW_DENIED", "SCHOOL_GOVERNANCE_IDENTITY_REQUIRES_FOUNDER"].includes(error.code)) return createApiError("FORBIDDEN");
  return createApiError("CONFLICT");
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
