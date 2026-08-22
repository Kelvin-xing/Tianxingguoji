import type { PrimaryGuardianRelationshipType } from "../../../../modules/crm/public.ts";
import { isPrimaryGuardianRelationshipType } from "../../../../modules/crm/public.ts";
import type { StudentCreateCommand } from "../../../../modules/crm/server.ts";
import { createApiError } from "../../../../modules/shared/public.ts";

const TOP_LEVEL_FIELDS = Object.freeze(["primary_guardian", "student"] as const);
const STUDENT_FIELDS = Object.freeze([
  "contact_email",
  "contact_phone",
  "date_of_birth",
  "display_name",
] as const);
const GUARDIAN_FIELDS = Object.freeze([
  "display_name",
  "email",
  "is_legal_guardian",
  "phone",
  "relationship_type",
] as const);

export async function parseStudentCreateRequest(
  request: Request,
  requestId: string,
): Promise<StudentCreateCommand> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw createApiError("INVALID_REQUEST");
  }
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey) throw createApiError("INVALID_REQUEST");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw createApiError("INVALID_REQUEST");
  }
  if (!isExactRecord(body, TOP_LEVEL_FIELDS)) throw createApiError("INVALID_REQUEST");
  if (!isExactRecord(body.student, STUDENT_FIELDS) ||
      !isExactRecord(body.primary_guardian, GUARDIAN_FIELDS)) {
    throw createApiError("INVALID_REQUEST");
  }

  const student = body.student;
  const guardian = body.primary_guardian;
  if (
    typeof student.display_name !== "string" ||
    !isNullableString(student.date_of_birth) ||
    !isNullableString(student.contact_email) ||
    !isNullableString(student.contact_phone) ||
    typeof guardian.display_name !== "string" ||
    !isNullableString(guardian.email) ||
    !isNullableString(guardian.phone) ||
    !isPrimaryGuardianRelationshipType(guardian.relationship_type) ||
    typeof guardian.is_legal_guardian !== "boolean"
  ) {
    throw createApiError("VALIDATION_FAILED");
  }

  return Object.freeze({
    student: Object.freeze({
      displayName: student.display_name,
      dateOfBirth: student.date_of_birth,
      contactEmail: student.contact_email,
      contactPhone: student.contact_phone,
    }),
    primaryGuardian: Object.freeze({
      displayName: guardian.display_name,
      email: guardian.email,
      phone: guardian.phone,
      relationshipType: guardian.relationship_type as PrimaryGuardianRelationshipType,
      isLegalGuardian: guardian.is_legal_guardian,
    }),
    requestId,
    idempotencyKey,
  });
}

function isExactRecord<const Fields extends readonly string[]>(
  value: unknown,
  fields: Fields,
): value is Record<Fields[number], unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === fields.length && fields.every((field, index) => field === keys[index]);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}
