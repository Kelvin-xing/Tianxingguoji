import { cookies } from "next/headers";

import { SESSION_COOKIE_NAME } from "@/modules/identity/server";
import {
  GuardianRelationshipError,
  GuardianRelationshipRuntimeUnavailable,
  getGuardianRelationshipRuntime,
} from "@/modules/crm/server";
import { IdentityRuntimeUnavailable, getIdentityRuntime } from "@/modules/identity/server";
import { IdentityServiceError } from "@/modules/identity/server";
import { createApiError, handleApiRequest } from "@/modules/shared/public";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_CODE = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: RouteContext<"/api/v1/students/[studentId]/guardians">,
): Promise<Response> {
  return handleApiRequest(request, async () => {
    const { studentId } = await context.params;
    const command = await parseAttachCommand(request, studentId);
    const cookieSecret = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
    if (!cookieSecret) throw createApiError("UNAUTHENTICATED");

    try {
      const actor = await getIdentityRuntime().service.requireSession({
        cookieSecret,
        sensitiveAction: false,
      });
      const relationship = await getGuardianRelationshipRuntime().service.attachGuardian({ actor, command });
      return toApiRelationship(relationship);
    } catch (error) {
      throw mapGuardianRelationshipError(error);
    }
  });
}

async function parseAttachCommand(request: Request, studentId: string) {
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!UUID.test(studentId) || !idempotencyKey) throw createApiError("INVALID_REQUEST");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw createApiError("INVALID_REQUEST");
  }
  if (!isRecord(body)) throw createApiError("INVALID_REQUEST");
  const guardianId = body.guardian_id;
  const relationshipType = body.relationship_type;
  const flags = [
    body.is_legal_guardian,
    body.is_primary_contact,
    body.is_emergency_contact,
    body.is_billing_contact,
    body.notification_consent,
  ];
  if (
    typeof guardianId !== "string" ||
    !UUID.test(guardianId) ||
    typeof relationshipType !== "string" ||
    !SAFE_CODE.test(relationshipType) ||
    flags.some((flag) => typeof flag !== "boolean")
  ) {
    throw createApiError("VALIDATION_FAILED");
  }
  return {
    studentId,
    guardianId,
    relationshipType,
    isLegalGuardian: body.is_legal_guardian as boolean,
    isPrimaryContact: body.is_primary_contact as boolean,
    isEmergencyContact: body.is_emergency_contact as boolean,
    isBillingContact: body.is_billing_contact as boolean,
    notificationConsent: body.notification_consent as boolean,
    requestId: request.headers.get("x-request-id")?.trim() || "guardian.relationship.attach",
    idempotencyKey,
  };
}

function toApiRelationship(relationship: {
  readonly relationshipId: string;
  readonly studentId: string;
  readonly guardianId: string;
  readonly relationshipType: string;
  readonly isLegalGuardian: boolean;
  readonly isPrimaryContact: boolean;
  readonly isEmergencyContact: boolean;
  readonly isBillingContact: boolean;
  readonly notificationConsent: boolean;
  readonly startsAtMs: number;
  readonly endsAtMs: number | null;
  readonly recordVersion: number;
}) {
  return {
    relationship_id: relationship.relationshipId,
    student_id: relationship.studentId,
    guardian_id: relationship.guardianId,
    relationship_type: relationship.relationshipType,
    is_legal_guardian: relationship.isLegalGuardian,
    is_primary_contact: relationship.isPrimaryContact,
    is_emergency_contact: relationship.isEmergencyContact,
    is_billing_contact: relationship.isBillingContact,
    notification_consent: relationship.notificationConsent,
    starts_at_ms: relationship.startsAtMs,
    ends_at_ms: relationship.endsAtMs,
    record_version: relationship.recordVersion,
  };
}

export function mapGuardianRelationshipError(error: unknown) {
  if (error instanceof IdentityRuntimeUnavailable || error instanceof GuardianRelationshipRuntimeUnavailable) {
    return createApiError("SERVICE_UNAVAILABLE");
  }
  if (error instanceof IdentityServiceError) return createApiError("UNAUTHENTICATED");
  if (!(error instanceof GuardianRelationshipError)) return createApiError("SERVICE_UNAVAILABLE");

  switch (error.code) {
    case "GUARDIAN_RELATIONSHIP_ADVISOR_REQUIRED":
      return createApiError("FORBIDDEN");
    case "GUARDIAN_RELATIONSHIP_STUDENT_NOT_FOUND":
    case "GUARDIAN_RELATIONSHIP_GUARDIAN_NOT_FOUND":
      return createApiError("NOT_FOUND");
    case "GUARDIAN_RELATIONSHIP_STALE_VERSION":
      return createApiError("STALE_VERSION");
    case "GUARDIAN_RELATIONSHIP_CURRENT_PAIR_EXISTS":
    case "GUARDIAN_RELATIONSHIP_PRIMARY_CONFLICT":
    case "GUARDIAN_RELATIONSHIP_IDEMPOTENCY_KEY_REUSED":
    case "GUARDIAN_RELATIONSHIP_IDEMPOTENCY_IN_PROGRESS":
      return createApiError("CONFLICT");
    case "GUARDIAN_RELATIONSHIP_INVALID":
    case "GUARDIAN_RELATIONSHIP_PRIMARY_REQUIRED":
      return createApiError("VALIDATION_FAILED");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
