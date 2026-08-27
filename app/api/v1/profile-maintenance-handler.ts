import { hasRequestCapability, type RequestAccessActor } from "../../../modules/access/public.ts";
import {
  isProfileMaintenanceError,
  isProfileMaintenanceRuntimeUnavailable,
  type GuardianProfileUpdateCommand,
  type ProfileUpdateAcknowledgement,
  type StudentProfileUpdateCommand,
} from "../../../modules/crm/server.ts";
import { createApiError } from "../../../modules/shared/public.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function assertProfileMaintenanceCapability(actor: RequestAccessActor): void {
  if (!hasRequestCapability(actor, "students.profiles.manage")) {
    throw createApiError("FORBIDDEN");
  }
}

export async function parseStudentProfileUpdate(
  request: Request,
  studentId: string,
  requestId: string,
): Promise<StudentProfileUpdateCommand> {
  assertTargetId(studentId);
  const body = await exactJson(request, ["display_name", "date_of_birth", "gender", "contact_email",
    "contact_phone", "expected_record_version"]);
  if (typeof body.display_name !== "string" ||
      (body.date_of_birth !== null && typeof body.date_of_birth !== "string") ||
      !isNullableGender(body.gender) ||
      (body.contact_email !== null && typeof body.contact_email !== "string") ||
      (body.contact_phone !== null && typeof body.contact_phone !== "string") ||
      typeof body.expected_record_version !== "number") {
    throw createApiError("VALIDATION_FAILED");
  }
  return Object.freeze({
    studentId,
    displayName: body.display_name as string,
    dateOfBirth: body.date_of_birth as string | null,
    gender: body.gender,
    contactEmail: body.contact_email as string | null,
    contactPhone: body.contact_phone as string | null,
    expectedRecordVersion: body.expected_record_version as number,
    requestId,
    idempotencyKey: requiredIdempotencyKey(request),
  });
}

export async function parseGuardianProfileUpdate(
  request: Request,
  guardianId: string,
  requestId: string,
): Promise<GuardianProfileUpdateCommand> {
  assertTargetId(guardianId);
  const body = await exactJson(request, ["display_name", "date_of_birth", "gender", "email", "phone",
    "expected_record_version"]);
  if (typeof body.display_name !== "string" ||
      (body.email !== null && typeof body.email !== "string") ||
      (body.phone !== null && typeof body.phone !== "string") ||
      (body.date_of_birth !== null && typeof body.date_of_birth !== "string") ||
      !isNullableGender(body.gender) ||
      typeof body.expected_record_version !== "number") {
    throw createApiError("VALIDATION_FAILED");
  }
  return Object.freeze({
    guardianId,
    displayName: body.display_name as string,
    email: body.email as string | null,
    phone: body.phone as string | null,
    dateOfBirth: body.date_of_birth as string | null,
    gender: body.gender,
    expectedRecordVersion: body.expected_record_version as number,
    requestId,
    idempotencyKey: requiredIdempotencyKey(request),
  });
}

function isNullableGender(value: unknown): value is "male" | "female" | "other" | "not_disclosed" | null {
  return value === null || value === "male" || value === "female" || value === "other" || value === "not_disclosed";
}

export function toProfileAcknowledgement(acknowledgement: ProfileUpdateAcknowledgement) {
  return {
    id: acknowledgement.id,
    record_version: acknowledgement.recordVersion,
    updated_at: acknowledgement.updatedAt,
  } as const;
}

export function mapProfileMaintenanceError(error: unknown): unknown {
  if (isProfileMaintenanceRuntimeUnavailable(error)) return createApiError("SERVICE_UNAVAILABLE");
  if (!isProfileMaintenanceError(error)) return error;
  switch (error.code) {
    case "PROFILE_MAINTENANCE_FORBIDDEN": return createApiError("FORBIDDEN");
    case "PROFILE_MAINTENANCE_NOT_FOUND": return createApiError("NOT_FOUND");
    case "PROFILE_MAINTENANCE_INACTIVE":
    case "PROFILE_MAINTENANCE_IDEMPOTENCY_CONFLICT":
    case "PROFILE_MAINTENANCE_IDEMPOTENCY_IN_PROGRESS": return createApiError("CONFLICT");
    case "PROFILE_MAINTENANCE_STALE_VERSION": return createApiError("STALE_VERSION");
    case "PROFILE_MAINTENANCE_INVALID": return createApiError("VALIDATION_FAILED");
    case "PROFILE_MAINTENANCE_UNAVAILABLE": return createApiError("SERVICE_UNAVAILABLE");
  }
}

function requiredIdempotencyKey(request: Request): string {
  const value = request.headers.get("idempotency-key")?.trim();
  if (!value) throw createApiError("INVALID_REQUEST");
  return value;
}

function assertTargetId(value: string): void {
  if (!UUID.test(value)) throw createApiError("NOT_FOUND");
}

async function exactJson(request: Request, fields: readonly string[]): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw createApiError("INVALID_REQUEST");
  }
  let value: unknown;
  try { value = await request.json(); } catch { throw createApiError("INVALID_REQUEST"); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw createApiError("INVALID_REQUEST");
  }
  const body = value as Record<string, unknown>;
  const actual = Object.keys(body);
  if (actual.length !== fields.length || fields.some((field) => !Object.hasOwn(body, field))) {
    throw createApiError("INVALID_REQUEST");
  }
  return body;
}
