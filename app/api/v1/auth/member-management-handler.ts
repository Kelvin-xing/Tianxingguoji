import {
  isMemberManagementError,
  isMemberManagementRuntimeUnavailable,
  type MemberMutationReceipt,
  type OwnEmployeeProfile,
} from "@/modules/access/server";
import { createApiError, type JsonValue } from "@/modules/shared/public";

const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACCESS_VERSION = /^v1:[1-9]\d*:\d+:(?:none|[0-9a-f@,.-]+)$/i;
const ROLES = new Set(["founder", "admin", "advisor", "contractor"] as const);

export async function parseOwnDisplayNameUpdate(request: Request) {
  const body = await exactJson(request, ["display_name", "expected_profile_record_version"]);
  if (
    typeof body.display_name !== "string" ||
    (body.expected_profile_record_version !== null &&
      (!Number.isSafeInteger(body.expected_profile_record_version) ||
        Number(body.expected_profile_record_version) < 1))
  ) {
    throw createApiError("VALIDATION_FAILED");
  }
  return Object.freeze({
    displayName: body.display_name,
    expectedProfileRecordVersion: body.expected_profile_record_version === null
      ? null
      : Number(body.expected_profile_record_version),
    idempotencyKey: requireIdempotencyKey(request),
  });
}

export async function parseMemberAccessUpdate(request: Request, userId: string) {
  if (!UUID.test(userId)) throw createApiError("INVALID_REQUEST");
  const body = await exactJson(request, [
    "display_name",
    "employment_type",
    "expected_access_version",
    "roles",
  ]);
  if (
    typeof body.display_name !== "string" ||
    (body.employment_type !== "FULL_TIME" && body.employment_type !== "PART_TIME") ||
    typeof body.expected_access_version !== "string" ||
    !ACCESS_VERSION.test(body.expected_access_version) ||
    !Array.isArray(body.roles) ||
    !body.roles.every((role) => typeof role === "string" && ROLES.has(role as never))
  ) {
    throw createApiError("VALIDATION_FAILED");
  }
  return Object.freeze({
    userId,
    displayName: body.display_name,
    employmentType: body.employment_type,
    expectedAccessVersion: body.expected_access_version,
    roles: Object.freeze([...body.roles] as string[]),
    idempotencyKey: requireIdempotencyKey(request),
  });
}

export function ownProfileData(profile: OwnEmployeeProfile): JsonValue {
  return {
    user_id: profile.userId,
    email: profile.normalizedEmail,
    display_name: profile.displayName,
    employment_type: profile.employmentType,
    profile_record_version: profile.recordVersion,
    updated_at: profile.updatedAt,
  };
}

export function memberReceiptData(receipt: MemberMutationReceipt): JsonValue {
  return {
    user_id: receipt.userId,
    receipt_id: receipt.receiptId,
    replayed: receipt.replayed,
  };
}

export function mapMemberManagementError(error: unknown): unknown {
  if (isMemberManagementRuntimeUnavailable(error)) return createApiError("SERVICE_UNAVAILABLE");
  if (!isMemberManagementError(error)) return error;
  if (error.code === "FORBIDDEN") return createApiError("FORBIDDEN");
  if (error.code === "INVALID") return createApiError("VALIDATION_FAILED");
  if (error.code === "NOT_FOUND") return createApiError("NOT_FOUND");
  if (error.code === "STALE_VERSION") return createApiError("STALE_VERSION");
  if (error.code === "UNAVAILABLE") return createApiError("SERVICE_UNAVAILABLE");
  return createApiError("CONFLICT");
}

async function exactJson(request: Request, keys: readonly string[]) {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") {
    throw createApiError("INVALID_REQUEST");
  }
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw createApiError("INVALID_REQUEST");
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== [...keys].sort().join(",")
  ) {
    throw createApiError("INVALID_REQUEST");
  }
  return value as Record<string, unknown>;
}

function requireIdempotencyKey(request: Request): string {
  const value = request.headers.get("idempotency-key")?.trim();
  if (!value || !IDEMPOTENCY_KEY.test(value)) throw createApiError("INVALID_REQUEST");
  return value;
}
