import { cookies } from "next/headers";

import { SESSION_COOKIE_NAME } from "@/modules/identity/server";
import {
  ResolvedSchoolViewRuntimeUnavailable,
  getResolvedSchoolViewRuntime,
} from "@/modules/schools/server";
import {
  SchoolResolutionError,
  type ResolvedSchoolTargetView,
} from "@/modules/schools/server";
import { IdentityRuntimeUnavailable, getIdentityRuntime } from "@/modules/identity/server";
import { IdentityServiceError } from "@/modules/identity/server";
import { createApiError, handleApiRequest } from "@/modules/shared/public";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { readonly params: Promise<{ readonly schoolId: string }> },
): Promise<Response> {
  return handleApiRequest(request, async () => {
    const { schoolId } = await context.params;
    if (!UUID.test(schoolId)) throw createApiError("INVALID_REQUEST");
    const cookieSecret = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
    if (!cookieSecret) throw createApiError("UNAUTHENTICATED");

    try {
      const actor = await getIdentityRuntime().service.requireSession({
        cookieSecret,
        sensitiveAction: false,
      });
      const resolved = await getResolvedSchoolViewRuntime().service.getResolvedSchool({
        actor,
        schoolId,
      });
      return resolvedPayload(resolved);
    } catch (error) {
      throw mapSchoolResolutionError(error);
    }
  });
}

function resolvedPayload(resolved: ResolvedSchoolTargetView) {
  return {
    school_id: resolved.view.schoolId,
    resolved_revision_id: resolved.pin.resolvedRevisionId,
    base_snapshot_id: resolved.pin.baseSnapshotId,
    overlay_revision_id: resolved.pin.overlayRevisionId,
    resolution_sha256: resolved.pin.resolutionSha256,
    fields: resolved.view.fields,
    provenance: Object.fromEntries(
      Object.entries(resolved.pin.provenance).map(([fieldName, provenance]) => [
        fieldName,
        {
          source_kind: provenance.sourceKind,
          source_snapshot_id: provenance.sourceSnapshotId,
          source_school_key: provenance.sourceSchoolKey,
          ...(provenance.overlayRevisionId
            ? { overlay_revision_id: provenance.overlayRevisionId }
            : {}),
          ...(provenance.baseValueSha256 ? { base_value_sha256: provenance.baseValueSha256 } : {}),
          value_sha256: provenance.valueSha256,
        },
      ]),
    ),
    conflicts: resolved.view.conflicts.map((conflict) => ({
      field_name: conflict.fieldName,
      kind: conflict.kind,
      previous_base_value_sha256: conflict.previousBaseValueSha256,
      current_base_value_sha256: conflict.currentBaseValueSha256,
    })),
  };
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
