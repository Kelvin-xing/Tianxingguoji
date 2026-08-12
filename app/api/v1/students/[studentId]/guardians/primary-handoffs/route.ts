import { cookies } from "next/headers";

import { SESSION_COOKIE_NAME } from "@/lib/auth/cookies";
import { getGuardianRelationshipRuntime } from "@/modules/crm/runtime";
import { IdentityRuntimeUnavailable, getIdentityRuntime } from "@/modules/identity/runtime";
import { IdentityServiceError } from "@/modules/identity/service";
import { createApiError, handleApiRequest } from "@/modules/shared/api-contract";

import { mapGuardianRelationshipError } from "../route";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_CODE = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: RouteContext<"/api/v1/students/[studentId]/guardians/primary-handoffs">,
): Promise<Response> {
  return handleApiRequest(request, async () => {
    const { studentId } = await context.params;
    const command = await parseHandoffCommand(request, studentId);
    const cookieSecret = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
    if (!cookieSecret) throw createApiError("UNAUTHENTICATED");

    try {
      const actor = await getIdentityRuntime().service.requireSession({
        cookieSecret,
        sensitiveAction: false,
      });
      const relationship = await getGuardianRelationshipRuntime().service.handoffPrimaryContact({ actor, command });
      return {
        relationship_id: relationship.relationshipId,
        student_id: relationship.studentId,
        guardian_id: relationship.guardianId,
        is_primary_contact: relationship.isPrimaryContact,
        starts_at_ms: relationship.startsAtMs,
        record_version: relationship.recordVersion,
      };
    } catch (error) {
      if (error instanceof IdentityRuntimeUnavailable || error instanceof IdentityServiceError) {
        throw createApiError(error instanceof IdentityServiceError ? "UNAUTHENTICATED" : "SERVICE_UNAVAILABLE");
      }
      throw mapGuardianRelationshipError(error);
    }
  });
}

async function parseHandoffCommand(request: Request, studentId: string) {
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!UUID.test(studentId) || !idempotencyKey) throw createApiError("INVALID_REQUEST");
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw createApiError("INVALID_REQUEST");
  }
  if (!isRecord(body)) throw createApiError("INVALID_REQUEST");
  const successorGuardianId = body.successor_guardian_id;
  const expectedPrimaryRecordVersion = body.expected_primary_record_version;
  const reason = body.reason;
  if (
    typeof successorGuardianId !== "string" ||
    !UUID.test(successorGuardianId) ||
    !Number.isSafeInteger(expectedPrimaryRecordVersion) ||
    expectedPrimaryRecordVersion < 1 ||
    typeof reason !== "string" ||
    !SAFE_CODE.test(reason)
  ) {
    throw createApiError("VALIDATION_FAILED");
  }
  return {
    studentId,
    successorGuardianId,
    expectedPrimaryRecordVersion,
    reason,
    requestId: request.headers.get("x-request-id")?.trim() || "guardian.primary.handoff",
    idempotencyKey,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
