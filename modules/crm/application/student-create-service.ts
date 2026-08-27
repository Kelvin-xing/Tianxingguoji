import { randomUUID } from "node:crypto";

import { hasRequestCapability, type RequestAccessActor } from "../../access/public.ts";
import {
  buildAtomicMutationEffects,
  buildAuditEvent,
  buildOutboxMessage,
  type MutationEffectBundle,
} from "../../audit/public.ts";
import { hashRequestPayload, validateIdempotencyKey } from "../../shared/public.ts";
import {
  isPrimaryGuardianRelationshipType,
  type PrimaryGuardianRelationshipType,
} from "../domain/contract.ts";
import { validateRelationshipDescription } from "../domain/approved-p2-contract.ts";
import type { CrmGender, StudentGuardianRelationshipType } from "../domain/approved-p2-contract.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface StudentCreateCommand {
  readonly student: {
    readonly displayName: string;
    readonly dateOfBirth: string | null;
    readonly gender?: CrmGender | null;
    readonly contactEmail: string | null;
    readonly contactPhone: string | null;
    readonly warningToken?: string | null;
  };
  readonly primaryGuardian: {
    readonly kind: "new";
    readonly displayName: string;
    readonly email: string | null;
    readonly phone: string | null;
    readonly dateOfBirth?: string | null;
    readonly gender?: CrmGender | null;
    readonly warningToken?: string | null;
    readonly relationshipType: StudentGuardianRelationshipType;
    readonly relationshipDescription: string | null;
    readonly isLegalGuardian: boolean;
    readonly isEmergencyContact: boolean;
    readonly isBillingContact: boolean;
    readonly notificationConsent: boolean;
  } | {
    readonly kind: "existing";
    readonly guardianId: string;
    readonly relationshipType: PrimaryGuardianRelationshipType;
    readonly relationshipDescription: string | null;
    readonly isLegalGuardian: boolean;
    readonly isEmergencyContact: boolean;
    readonly isBillingContact: boolean;
    readonly notificationConsent: boolean;
    readonly warningToken?: never;
  };
  readonly requestId: string;
  readonly idempotencyKey: string;
}

export interface CreatedStudentAggregate {
  readonly student: Readonly<{ id: string; recordVersion: number }>;
  readonly primaryGuardian: Readonly<{ id: string; recordVersion: number }>;
  readonly relationship: Readonly<{
    id: string;
    recordVersion: number;
  }>;
}

export interface StudentCreateRepository {
  createStudent(input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly studentId: string;
    readonly guardianId: string;
    readonly relationshipId: string;
    readonly student: StudentCreateCommand["student"];
    readonly primaryGuardian: StudentCreateCommand["primaryGuardian"];
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly createdAtMs: number;
    readonly effects: MutationEffectBundle;
  }): Promise<CreatedStudentAggregate>;
}

export type StudentCreateErrorCode =
  | "STUDENT_CREATE_DUPLICATE_WARNING_REQUIRED"
  | "STUDENT_CREATE_FORBIDDEN"
  | "STUDENT_CREATE_INVALID"
  | "STUDENT_CREATE_IDEMPOTENCY_CONFLICT"
  | "STUDENT_CREATE_IDEMPOTENCY_IN_PROGRESS"
  | "STUDENT_CREATE_UNAVAILABLE";

export class StudentCreateError extends Error {
  readonly code: StudentCreateErrorCode;

  constructor(code: StudentCreateErrorCode) {
    super(`Student create rejected ${code}.`);
    this.name = "StudentCreateError";
    this.code = code;
  }
}

const STUDENT_CREATE_ERROR_CODES = new Set<StudentCreateErrorCode>([
  "STUDENT_CREATE_DUPLICATE_WARNING_REQUIRED",
  "STUDENT_CREATE_FORBIDDEN",
  "STUDENT_CREATE_INVALID",
  "STUDENT_CREATE_IDEMPOTENCY_CONFLICT",
  "STUDENT_CREATE_IDEMPOTENCY_IN_PROGRESS",
  "STUDENT_CREATE_UNAVAILABLE",
]);

export function isStudentCreateError(
  error: unknown,
  code?: StudentCreateErrorCode,
): error is StudentCreateError {
  if (!(error instanceof Error) || error.name !== "StudentCreateError") return false;
  const candidate = (error as Error & { readonly code?: unknown }).code;
  if (
    typeof candidate !== "string" ||
    !STUDENT_CREATE_ERROR_CODES.has(candidate as StudentCreateErrorCode)
  ) {
    return false;
  }
  return code === undefined || candidate === code;
}

export class StudentCreateRepositoryError extends Error {
  readonly code: StudentCreateErrorCode;

  constructor(code: StudentCreateRepositoryError["code"]) {
    super(`Student create repository rejected ${code}.`);
    this.name = "StudentCreateRepositoryError";
    this.code = code;
  }
}

export class StudentCreateService {
  private readonly repository: StudentCreateRepository;
  private readonly createId: () => string;
  private readonly nowMs: () => number;

  constructor(
    repository: StudentCreateRepository,
    createId: () => string = randomUUID,
    nowMs: () => number = Date.now,
  ) {
    this.repository = repository;
    this.createId = createId;
    this.nowMs = nowMs;
  }

  async create(input: {
    readonly actor: RequestAccessActor;
    readonly command: StudentCreateCommand;
  }): Promise<CreatedStudentAggregate> {
    assertAuthorizedActor(input.actor);
    const command = normalizeCommand(input.command);
    const generated = Array.from({ length: input.command.primaryGuardian.kind === "new" ? 5 : 4 }, () => this.createId());
    const studentId = generated[0]!;
    const guardianId = input.command.primaryGuardian.kind === "new" ? generated[1]! : input.command.primaryGuardian.guardianId;
    const relationshipId = input.command.primaryGuardian.kind === "new" ? generated[2]! : generated[1]!;
    const auditId = input.command.primaryGuardian.kind === "new" ? generated[3]! : generated[2]!;
    const outboxId = input.command.primaryGuardian.kind === "new" ? generated[4]! : generated[3]!;
    for (const id of [studentId, guardianId, relationshipId, auditId, outboxId]) {
      if (!UUID.test(id)) throw new StudentCreateError("STUDENT_CREATE_INVALID");
    }
    const createdAtMs = this.nowMs();
    if (!Number.isFinite(createdAtMs) || createdAtMs <= 0) {
      throw new StudentCreateError("STUDENT_CREATE_INVALID");
    }
    const occurredAt = new Date(createdAtMs).toISOString();
    const requestHash = hashRequestPayload(JSON.parse(JSON.stringify({ primaryGuardian: command.primaryGuardian, student: command.student })));
    const audit = buildAuditEvent({
      id: auditId,
      organizationId: input.actor.organizationId,
      actorUserId: input.actor.userId,
      actorKind: "user",
      eventType: "crm.student_primary_guardian_created",
      eventVersion: 1,
      action: "create",
      resourceType: "Student",
      resourceId: studentId,
      outcome: "succeeded",
      requestId: command.requestId,
      occurredAt,
      metadata: {
        effect_type: "crm.student_created",
        record_version: 1,
        status: "active",
      },
    });
    const outbox = buildOutboxMessage({
      id: outboxId,
      auditEventId: auditId,
      organizationId: input.actor.organizationId,
      aggregateType: "Student",
      aggregateId: studentId,
      eventType: "crm.student_primary_guardian_created",
      eventVersion: 1,
      idempotencyKey: `crm-student-create-${outboxId}`,
      requestId: command.requestId,
      payload: {
        aggregate_id: studentId,
        effect_type: "crm.student_created",
        record_version: 1,
        request_id: command.requestId,
        status: "active",
      },
      availableAt: occurredAt,
      createdAt: occurredAt,
    });

    try {
      return await this.repository.createStudent({
        organizationId: input.actor.organizationId,
        actorUserId: input.actor.userId,
        studentId,
        guardianId,
        relationshipId,
        student: command.student,
        primaryGuardian: command.primaryGuardian,
        idempotencyKey: command.idempotencyKey,
        requestHash,
        createdAtMs,
        effects: buildAtomicMutationEffects({ audit, outbox }),
      });
    } catch (error) {
      if (error instanceof StudentCreateRepositoryError) {
        throw new StudentCreateError(error.code);
      }
      throw error;
    }
  }
}

function assertAuthorizedActor(actor: RequestAccessActor): void {
  if (!UUID.test(actor.organizationId) || !UUID.test(actor.userId)) {
    throw new StudentCreateError("STUDENT_CREATE_FORBIDDEN");
  }
  if (!hasRequestCapability(actor, "students.create")) {
    throw new StudentCreateError("STUDENT_CREATE_FORBIDDEN");
  }
}

function normalizeCommand(command: StudentCreateCommand): StudentCreateCommand {
  const student = Object.freeze({
    displayName: normalizeRequired(command.student.displayName, 512),
    dateOfBirth: normalizeDate(command.student.dateOfBirth),
    gender: normalizeGender(command.student.gender),
    contactEmail: normalizeEmail(command.student.contactEmail),
    contactPhone: normalizeOptional(command.student.contactPhone, 64),
    warningToken: command.student.warningToken ?? null,
  });
  const guardianInput = command.primaryGuardian;
  const primaryGuardian = guardianInput.kind === "existing" ? Object.freeze({
    kind: "existing" as const, guardianId: guardianInput.guardianId,
    relationshipType: guardianInput.relationshipType, relationshipDescription: guardianInput.relationshipDescription ?? null,
    isLegalGuardian: guardianInput.isLegalGuardian, isEmergencyContact: guardianInput.isEmergencyContact,
    isBillingContact: guardianInput.isBillingContact, notificationConsent: guardianInput.notificationConsent,
  }) : Object.freeze({
    kind: "new" as const,
    displayName: normalizeRequired(guardianInput.displayName, 512),
    email: normalizeEmail(guardianInput.email), phone: normalizeOptional(guardianInput.phone, 64),
    dateOfBirth: normalizeDate(guardianInput.dateOfBirth), gender: normalizeGender(guardianInput.gender),
    relationshipType: guardianInput.relationshipType, relationshipDescription: guardianInput.relationshipDescription,
    isLegalGuardian: guardianInput.isLegalGuardian, isEmergencyContact: guardianInput.isEmergencyContact,
    isBillingContact: guardianInput.isBillingContact, notificationConsent: guardianInput.notificationConsent,
    warningToken: guardianInput.warningToken ?? null,
  });
  if (
    !isPrimaryGuardianRelationshipType(primaryGuardian.relationshipType as never) ||
    !validateRelationshipDescription(primaryGuardian) ||
    typeof primaryGuardian.isLegalGuardian !== "boolean" ||
    (primaryGuardian.kind === "new" && primaryGuardian.email === null && primaryGuardian.phone === null) ||
    !REQUEST_ID.test(command.requestId)
  ) {
    throw new StudentCreateError("STUDENT_CREATE_INVALID");
  }
  try {
    validateIdempotencyKey(command.idempotencyKey);
  } catch {
    throw new StudentCreateError("STUDENT_CREATE_INVALID");
  }
  return Object.freeze({
    student,
    primaryGuardian,
    requestId: command.requestId,
    idempotencyKey: command.idempotencyKey,
  });
}

function normalizeRequired(value: unknown, maximumLength: number): string {
  if (typeof value !== "string") throw new StudentCreateError("STUDENT_CREATE_INVALID");
  const result = value.trim();
  if (!result || result.length > maximumLength) {
    throw new StudentCreateError("STUDENT_CREATE_INVALID");
  }
  return result;
}

function normalizeOptional(value: unknown, maximumLength: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new StudentCreateError("STUDENT_CREATE_INVALID");
  const result = value.trim();
  if (!result) return null;
  if (result.length > maximumLength) throw new StudentCreateError("STUDENT_CREATE_INVALID");
  return result;
}

function normalizeEmail(value: unknown): string | null {
  const result = normalizeOptional(value, 320)?.toLowerCase() ?? null;
  if (result !== null && !EMAIL.test(result)) {
    throw new StudentCreateError("STUDENT_CREATE_INVALID");
  }
  return result;
}

function normalizeGender(value: unknown): CrmGender | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !["male", "female", "other", "not_disclosed"].includes(value)) {
    throw new StudentCreateError("STUDENT_CREATE_INVALID");
  }
  return value as CrmGender;
}

function normalizeDate(value: unknown): string | null {
  if (value === undefined) return null;
  if (value === null) return null;
  if (typeof value !== "string" || !DATE.test(value)) {
    throw new StudentCreateError("STUDENT_CREATE_INVALID");
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new StudentCreateError("STUDENT_CREATE_INVALID");
  }
  return value;
}
