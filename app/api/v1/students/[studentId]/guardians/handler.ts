import {
  GuardianRelationshipRuntimeUnavailable,
  isGuardianRelationshipError,
  type GuardianContactHint,
  type GuardianRelationshipResult,
  type GuardianRelationshipsView,
  type PrimaryGuardianHandoffResult,
} from "../../../../../../modules/crm/server.ts";
import { isPrimaryGuardianRelationshipType } from "../../../../../../modules/crm/public.ts";
import { validateRelationshipDescription } from "../../../../../../modules/crm/public.ts";
import { createApiError } from "../../../../../../modules/shared/public.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function parseAttachCommand(request: Request, studentId: string, requestId: string) {
  const idempotencyKey = requiredIdempotencyKey(request, studentId);
  const body = await exactJson(request, [
    "guardian_id",
    "relationship_type",
    "relationship_description",
    "is_legal_guardian",
    "is_emergency_contact",
    "is_billing_contact",
    "notification_consent",
  ]);
  if (typeof body.guardian_id !== "string" || !UUID.test(body.guardian_id) ||
      !isPrimaryGuardianRelationshipType(body.relationship_type) ||
      (body.relationship_description !== null && typeof body.relationship_description !== "string") ||
      !validateRelationshipDescription({ relationshipType: body.relationship_type, relationshipDescription: body.relationship_description as string | null }) ||
      [body.is_legal_guardian, body.is_emergency_contact, body.is_billing_contact,
        body.notification_consent].some((value) => typeof value !== "boolean")) {
    throw createApiError("VALIDATION_FAILED");
  }
  return Object.freeze({
    studentId,
    guardianId: body.guardian_id,
    relationshipType: body.relationship_type,
    relationshipDescription: body.relationship_description as string | null,
    isLegalGuardian: body.is_legal_guardian as boolean,
    isEmergencyContact: body.is_emergency_contact as boolean,
    isBillingContact: body.is_billing_contact as boolean,
    notificationConsent: body.notification_consent as boolean,
    requestId,
    idempotencyKey,
  });
}

export async function parseSearchRequest(request: Request, studentId: string) {
  assertStudentId(studentId);
  const body = await exactJson(request, ["query"]);
  if (typeof body.query !== "string") throw createApiError("VALIDATION_FAILED");
  const query = body.query.trim();
  if (query.length < 2 || query.length > 100) throw createApiError("VALIDATION_FAILED");
  return Object.freeze({ studentId, query });
}

export async function parseHandoffCommand(request: Request, studentId: string, requestId: string) {
  const idempotencyKey = requiredIdempotencyKey(request, studentId);
  const body = await exactJson(request, [
    "successor_guardian_id",
    "expected_primary_record_version",
  ]);
  if (typeof body.successor_guardian_id !== "string" ||
      !UUID.test(body.successor_guardian_id) ||
      typeof body.expected_primary_record_version !== "number" ||
      !Number.isSafeInteger(body.expected_primary_record_version) ||
      body.expected_primary_record_version < 1) {
    throw createApiError("VALIDATION_FAILED");
  }
  return Object.freeze({
    studentId,
    successorGuardianId: body.successor_guardian_id,
    expectedPrimaryRecordVersion: body.expected_primary_record_version,
    requestId,
    idempotencyKey,
  });
}

export async function parseEndCommand(request: Request, studentId: string, relationshipId: string, requestId: string) {
  const idempotencyKey = requiredIdempotencyKey(request, studentId);
  assertStudentId(studentId); if (!UUID.test(relationshipId)) throw createApiError("INVALID_REQUEST");
  const body = await exactJson(request, ["expected_record_version"]);
  if (typeof body.expected_record_version !== "number" || !Number.isSafeInteger(body.expected_record_version) || body.expected_record_version < 1) throw createApiError("VALIDATION_FAILED");
  return { studentId, relationshipId, expectedRecordVersion: body.expected_record_version, requestId, idempotencyKey } as const;
}

export function toEndData(result: { relationshipId:string; studentId:string; status:"ended"; endsAt:string; recordVersion:number; occurredAt:string }) {
  return { relationship: { id: result.relationshipId, student_id: result.studentId, status: result.status, ends_at: result.endsAt, record_version: result.recordVersion }, occurred_at: result.occurredAt } as const;
}

export function mapGuardianRelationshipError(error: unknown): unknown {
  if (error instanceof GuardianRelationshipRuntimeUnavailable) {
    return createApiError("SERVICE_UNAVAILABLE");
  }
  if (!isGuardianRelationshipError(error)) return error;
  switch (error.code) {
    case "GUARDIAN_RELATIONSHIP_FORBIDDEN": return createApiError("FORBIDDEN");
    case "GUARDIAN_RELATIONSHIP_STUDENT_NOT_FOUND":
    case "GUARDIAN_RELATIONSHIP_GUARDIAN_NOT_FOUND": return createApiError("NOT_FOUND");
    case "GUARDIAN_RELATIONSHIP_NOT_FOUND": return createApiError("NOT_FOUND");
    case "GUARDIAN_RELATIONSHIP_STALE_VERSION": return createApiError("STALE_VERSION");
    case "GUARDIAN_RELATIONSHIP_PRIMARY_REQUIRED":
    case "GUARDIAN_RELATIONSHIP_CURRENT_PAIR_EXISTS":
    case "GUARDIAN_RELATIONSHIP_PRIMARY_CONFLICT":
    case "GUARDIAN_RELATIONSHIP_PRIMARY_CANNOT_END":
    case "GUARDIAN_RELATIONSHIP_IDEMPOTENCY_KEY_REUSED":
    case "GUARDIAN_RELATIONSHIP_IDEMPOTENCY_IN_PROGRESS": return createApiError("CONFLICT");
    case "GUARDIAN_RELATIONSHIP_INVALID": return createApiError("VALIDATION_FAILED");
    case "GUARDIAN_RELATIONSHIP_UNAVAILABLE": return createApiError("SERVICE_UNAVAILABLE");
  }
}

export function toCurrentRelationshipsData(view: GuardianRelationshipsView) {
  return {
    student: { id: view.student.id, display_name: view.student.displayName },
    relationships: view.relationships.map(({ relationship, guardian }) => ({
      relationship_id: relationship.relationshipId,
      guardian: toGuardianHintData(guardian),
      relationship_type: relationship.relationshipType,
      relationship_description: relationship.relationshipDescription ?? null,
      is_legal_guardian: relationship.isLegalGuardian,
      is_primary_contact: relationship.isPrimaryContact,
      is_emergency_contact: relationship.isEmergencyContact,
      is_billing_contact: relationship.isBillingContact,
      notification_consent: relationship.notificationConsent,
      starts_at: relationship.startsAt,
      record_version: relationship.recordVersion,
    })),
  } as const;
}

export function toGuardianHintData(guardian: GuardianContactHint) {
  return {
    id: guardian.id,
    display_name: guardian.displayName,
    email_hint: guardian.emailHint,
    phone_hint: guardian.phoneHint,
  } as const;
}

export function toRelationshipData(relationship: GuardianRelationshipResult) {
  return {
    relationship_id: relationship.relationshipId,
    guardian_id: relationship.guardianId,
    relationship_type: relationship.relationshipType,
    relationship_description: relationship.relationshipDescription ?? null,
    is_legal_guardian: relationship.isLegalGuardian,
    is_primary_contact: relationship.isPrimaryContact,
    is_emergency_contact: relationship.isEmergencyContact,
    is_billing_contact: relationship.isBillingContact,
    notification_consent: relationship.notificationConsent,
    starts_at: relationship.startsAt,
    record_version: relationship.recordVersion,
  } as const;
}

export function toHandoffData(result: PrimaryGuardianHandoffResult) {
  return {
    relationship: toRelationshipData(result.relationship),
    closed_relationship_ids: {
      previous_primary: result.closedRelationshipIds.previousPrimary,
      successor_secondary: result.closedRelationshipIds.successorSecondary,
    },
  } as const;
}

function requiredIdempotencyKey(request: Request, studentId: string): string {
  assertStudentId(studentId);
  const value = request.headers.get("idempotency-key")?.trim();
  if (!value) throw createApiError("INVALID_REQUEST");
  return value;
}

function assertStudentId(studentId: string): void {
  if (!UUID.test(studentId)) throw createApiError("INVALID_REQUEST");
}

async function exactJson(request: Request, keys: readonly string[]): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw createApiError("INVALID_REQUEST");
  }
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw createApiError("INVALID_REQUEST");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw createApiError("INVALID_REQUEST");
  }
  const body = value as Record<string, unknown>;
  const actual = Object.keys(body);
  if (actual.length !== keys.length || keys.some((key) => !Object.hasOwn(body, key))) {
    throw createApiError("INVALID_REQUEST");
  }
  return body;
}
