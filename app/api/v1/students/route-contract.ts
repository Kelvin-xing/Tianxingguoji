import { STUDENT_GUARDIAN_RELATIONSHIP_TYPES, type StudentGuardianRelationshipType, type CrmGender } from "../../../../modules/crm/public.ts";
import type { StudentCreateCommand } from "../../../../modules/crm/public.ts";
import { createApiError } from "../../../../modules/shared/public.ts";
import { validateRelationshipDescription } from "../../../../modules/crm/public.ts";

const TOP_LEVEL_FIELDS = Object.freeze(["primary_guardian", "student", "warning_token"] as const);
const STUDENT_FIELDS = Object.freeze([
  "contact_email",
  "contact_phone",
  "date_of_birth",
  "display_name",
  "gender",
] as const);
const GUARDIAN_FIELDS = Object.freeze([
  "display_name",
  "date_of_birth",
  "email",
  "gender",
  "is_legal_guardian",
  "is_emergency_contact",
  "is_billing_contact",
  "notification_consent",
  "phone",
  "relationship_type", "relationship_description",
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
  if (!isAllowedRecord(body, ["primary_guardian", "student", "warning_token"], ["primary_guardian", "student"]) || (body.warning_token !== undefined && body.warning_token !== null && typeof body.warning_token !== "string")) throw createApiError("INVALID_REQUEST");
  if (!isAllowedRecord(body.student, STUDENT_FIELDS, ["display_name"]) || typeof body.primary_guardian !== "object" || body.primary_guardian === null) {
    throw createApiError("INVALID_REQUEST");
  }

  const student = body.student;
  const guardian = body.primary_guardian as Record<string, unknown>;
  const kind = guardian.kind;
  const relationshipDescription = guardian.relationship_description as string | null | undefined;
  const fields = kind === "new" ? [...GUARDIAN_FIELDS, "kind", "warning_token"] : ["kind", "guardian_id", "relationship_type", "relationship_description", "is_legal_guardian", "is_emergency_contact", "is_billing_contact", "notification_consent"];
  if (!isAllowedRecord(guardian, fields, kind === "new" ? ["kind", "display_name", "relationship_type", "is_legal_guardian", "is_emergency_contact", "is_billing_contact", "notification_consent"] : ["kind", "guardian_id", "relationship_type", "is_legal_guardian", "is_emergency_contact", "is_billing_contact", "notification_consent"])) throw createApiError("INVALID_REQUEST");
  if (
    typeof student.display_name !== "string" ||
    !isNullableString(student.date_of_birth) ||
    !isNullableGender(student.gender) ||
    !isNullableString(student.contact_email) ||
    !isNullableString(student.contact_phone) ||
    kind !== "new" && kind !== "existing" ||
    (kind === "existing" && (typeof guardian.guardian_id !== "string" || !/^[0-9a-f-]{36}$/i.test(guardian.guardian_id))) ||
    (kind === "new" && (typeof guardian.display_name !== "string" ||
    !isNullableString(guardian.date_of_birth) ||
    !isNullableGender(guardian.gender) ||
    !isNullableString(guardian.email) ||
    !isNullableString(guardian.phone) ||
    !STUDENT_GUARDIAN_RELATIONSHIP_TYPES.includes(guardian.relationship_type as StudentGuardianRelationshipType) ||
    (!isNullableString(guardian.relationship_description)) ||
    !validateRelationshipDescription({ relationshipType: guardian.relationship_type as StudentGuardianRelationshipType, relationshipDescription: relationshipDescription ?? null }) ||
    typeof guardian.is_legal_guardian !== "boolean" || typeof guardian.is_emergency_contact !== "boolean" || typeof guardian.is_billing_contact !== "boolean" || typeof guardian.notification_consent !== "boolean"))
  ) {
    throw createApiError("VALIDATION_FAILED");
  }

  const relationshipType = guardian.relationship_type as StudentGuardianRelationshipType;
  const primaryGuardian: StudentCreateCommand["primaryGuardian"] = kind === "existing"
    ? { kind: "existing", guardianId: guardian.guardian_id as string, relationshipType, relationshipDescription: relationshipDescription ?? null, isLegalGuardian: guardian.is_legal_guardian as boolean, isEmergencyContact: guardian.is_emergency_contact as boolean, isBillingContact: guardian.is_billing_contact as boolean, notificationConsent: guardian.notification_consent as boolean }
    : { kind: "new", displayName: guardian.display_name as string, email: (guardian.email as string | null | undefined) ?? null, phone: (guardian.phone as string | null | undefined) ?? null, dateOfBirth: (guardian.date_of_birth as string | null | undefined) ?? null, gender: ((guardian.gender as CrmGender | null | undefined) ?? null), relationshipType, relationshipDescription: (guardian.relationship_description as string | null | undefined) ?? null, isLegalGuardian: guardian.is_legal_guardian as boolean, isEmergencyContact: guardian.is_emergency_contact as boolean, isBillingContact: guardian.is_billing_contact as boolean, notificationConsent: guardian.notification_consent as boolean, warningToken: (guardian.warning_token as string | null | undefined) ?? null };
  return Object.freeze({
    student: Object.freeze({
      displayName: student.display_name,
      dateOfBirth: student.date_of_birth ?? null,
      gender: student.gender ?? null,
      contactEmail: student.contact_email ?? null,
      contactPhone: student.contact_phone ?? null,
      warningToken: body.warning_token as string | null,
    }),
    primaryGuardian: Object.freeze(primaryGuardian), /*
    kind === "existing" ? {
      kind: "existing" as const, guardianId: guardian.guardian_id as string, relationshipType: guardian.relationship_type as never,
      relationshipDescription: relationshipDescription ?? null, isLegalGuardian: guardian.is_legal_guardian as boolean,
      isEmergencyContact: guardian.is_emergency_contact as boolean, isBillingContact: guardian.is_billing_contact as boolean,
      notificationConsent: guardian.notification_consent as boolean,
    } : {
      kind: "new" as const,
      displayName: guardian.display_name,
      email: guardian.email,
      phone: guardian.phone,
      dateOfBirth: guardian.date_of_birth,
      gender: guardian.gender,
      relationshipType: guardian.relationship_type as never,
      relationshipDescription: guardian.relationship_description,
      isLegalGuardian: guardian.is_legal_guardian,
      isEmergencyContact: guardian.is_emergency_contact as boolean, isBillingContact: guardian.is_billing_contact as boolean,
      notificationConsent: guardian.notification_consent as boolean, warningToken: guardian.warning_token as string | null | undefined,
    }*/
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

function isAllowedRecord(value: unknown, allowed: readonly string[], required: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.every((key) => allowed.includes(key)) && required.every((key) => keys.includes(key));
}

function isNullableString(value: unknown): value is string | null {
  return value === undefined || value === null || typeof value === "string";
}

function isNullableGender(value: unknown): value is "male" | "female" | "other" | "not_disclosed" | null {
  return value === undefined || value === null || value === "male" || value === "female" || value === "other" || value === "not_disclosed";
}
