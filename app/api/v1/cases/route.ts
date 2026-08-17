import { cookies } from "next/headers";

import { SESSION_COOKIE_NAME } from "@/modules/identity/server";
import { CaseCreationError } from "@/modules/cases/server";
import { CaseRuntimeUnavailable, getCaseRuntime } from "@/modules/cases/server";
import { IdentityRuntimeUnavailable, getIdentityRuntime } from "@/modules/identity/server";
import { IdentityServiceError } from "@/modules/identity/server";
import { createApiError, handleApiRequest } from "@/modules/shared/public";

const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_CODE = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handleApiRequest(request, async () => {
    const command = await parseCaseCommand(request);
    const cookieSecret = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
    if (!cookieSecret) throw createApiError("UNAUTHENTICATED");

    try {
      const identity = getIdentityRuntime();
      const actor = await identity.service.requireSession({
        cookieSecret,
        sensitiveAction: false,
      });
      const result = await getCaseRuntime().service.createAdvisorK12Case({ actor, command });
      return {
        student_id: result.studentId,
        case_id: result.serviceCaseId,
        assessment_id: result.assessmentId,
        primary_advisor_user_id: result.primaryAdvisorUserId,
        stage: result.stage,
        record_version: result.recordVersion,
      };
    } catch (error) {
      throw mapCaseCreationError(error);
    }
  });
}

async function parseCaseCommand(request: Request): Promise<{
  readonly student: {
    readonly displayName: string;
    readonly dateOfBirth: string | null;
    readonly contactEmail: string | null;
    readonly contactPhone: string | null;
  };
  readonly intakeYear: number;
  readonly admissionType: string;
  readonly caseNumber: string;
  readonly schemaManifestId: string;
  readonly requestId: string;
  readonly idempotencyKey: string;
}> {
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
  if (!isRecord(body) || !isRecord(body.student)) throw createApiError("INVALID_REQUEST");

  const displayName = body.student.display_name;
  const dateOfBirth = nullableString(body.student.date_of_birth);
  const contactEmail = nullableString(body.student.contact_email);
  const contactPhone = nullableString(body.student.contact_phone);
  const intakeYear = body.intake_year;
  const admissionType = body.admission_type;
  const caseNumber = body.case_number;
  const schemaManifestId = body.schema_manifest_id;

  if (
    typeof displayName !== "string" ||
    displayName.trim().length === 0 ||
    displayName.length > 512 ||
    (dateOfBirth !== null && !ISO_DATE.test(dateOfBirth)) ||
    (contactEmail !== null && (contactEmail.trim().length === 0 || contactEmail.length > 320)) ||
    (contactPhone !== null && (contactPhone.trim().length === 0 || contactPhone.length > 64)) ||
    !Number.isSafeInteger(intakeYear) ||
    intakeYear < 1 ||
    typeof admissionType !== "string" ||
    !SAFE_CODE.test(admissionType) ||
    typeof caseNumber !== "string" ||
    !SAFE_CODE.test(caseNumber) ||
    typeof schemaManifestId !== "string" ||
    !UUID.test(schemaManifestId)
  ) {
    throw createApiError("VALIDATION_FAILED");
  }

  return {
    student: { displayName, dateOfBirth, contactEmail, contactPhone },
    intakeYear,
    admissionType,
    caseNumber,
    schemaManifestId,
    requestId: request.headers.get("x-request-id")?.trim() || "case.create",
    idempotencyKey,
  };
}

function mapCaseCreationError(error: unknown) {
  if (error instanceof IdentityRuntimeUnavailable || error instanceof CaseRuntimeUnavailable) {
    return createApiError("SERVICE_UNAVAILABLE");
  }
  if (error instanceof IdentityServiceError) return createApiError("UNAUTHENTICATED");
  if (!(error instanceof CaseCreationError)) return createApiError("SERVICE_UNAVAILABLE");

  switch (error.code) {
    case "CASE_ADVISOR_REQUIRED":
      return createApiError("FORBIDDEN");
    case "CASE_CREATION_ACTIVE_DUPLICATE":
    case "CASE_CREATION_IDEMPOTENCY_KEY_REUSED":
    case "CASE_CREATION_IDEMPOTENCY_IN_PROGRESS":
      return createApiError("CONFLICT");
    case "CASE_CREATION_MANIFEST_NOT_APPROVED":
    case "CASE_CREATION_PRIMARY_BINDING_INACTIVE":
    case "CASE_CREATION_INVALID":
      return createApiError("VALIDATION_FAILED");
  }
}

function nullableString(value: unknown): string | null | undefined {
  return value === null || typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
