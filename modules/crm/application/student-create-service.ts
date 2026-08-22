import { randomUUID } from "node:crypto";

import { evaluateBootstrapAuthorization } from "../../access/public.ts";
import {
  buildAtomicMutationEffects,
  buildAuditEvent,
  buildOutboxMessage,
  type MutationEffectBundle,
} from "../../audit/public.ts";
import type { IdentitySessionActor } from "../../identity/public.ts";
import { hashRequestPayload, validateIdempotencyKey } from "../../shared/public.ts";
import {
  isPrimaryGuardianRelationshipType,
  type PrimaryGuardianRelationshipType,
} from "../domain/contract.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface StudentCreateCommand {
  readonly student: {
    readonly displayName: string;
    readonly dateOfBirth: string | null;
    readonly contactEmail: string | null;
    readonly contactPhone: string | null;
  };
  readonly primaryGuardian: {
    readonly displayName: string;
    readonly email: string | null;
    readonly phone: string | null;
    readonly relationshipType: PrimaryGuardianRelationshipType;
    readonly isLegalGuardian: boolean;
  };
  readonly requestId: string;
  readonly idempotencyKey: string;
}

export interface CreatedStudentAggregate {
  readonly student: Readonly<{ id: string; displayName: string }>;
  readonly primaryGuardian: Readonly<{ id: string; displayName: string }>;
  readonly relationship: Readonly<{
    id: string;
    relationshipType: PrimaryGuardianRelationshipType;
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
  readonly code: Exclude<StudentCreateErrorCode, "STUDENT_CREATE_FORBIDDEN" | "STUDENT_CREATE_INVALID">;

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
    readonly actor: IdentitySessionActor;
    readonly command: StudentCreateCommand;
  }): Promise<CreatedStudentAggregate> {
    assertAuthorizedActor(input.actor);
    const command = normalizeCommand(input.command);
    const [studentId, guardianId, relationshipId, auditId, outboxId] = Array.from(
      { length: 5 },
      () => this.createId(),
    );
    for (const id of [studentId, guardianId, relationshipId, auditId, outboxId]) {
      if (!UUID.test(id)) throw new StudentCreateError("STUDENT_CREATE_INVALID");
    }
    const createdAtMs = this.nowMs();
    if (!Number.isFinite(createdAtMs) || createdAtMs <= 0) {
      throw new StudentCreateError("STUDENT_CREATE_INVALID");
    }
    const occurredAt = new Date(createdAtMs).toISOString();
    const requestHash = hashRequestPayload({
      primaryGuardian: command.primaryGuardian,
      student: command.student,
    });
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

function assertAuthorizedActor(actor: IdentitySessionActor): void {
  if (!UUID.test(actor.organizationId) || !UUID.test(actor.userId)) {
    throw new StudentCreateError("STUDENT_CREATE_FORBIDDEN");
  }
  const decision = evaluateBootstrapAuthorization(actor.role, { capability: "students.create" });
  if (!decision.allowed) throw new StudentCreateError("STUDENT_CREATE_FORBIDDEN");
}

function normalizeCommand(command: StudentCreateCommand): StudentCreateCommand {
  const student = Object.freeze({
    displayName: normalizeRequired(command.student.displayName, 512),
    dateOfBirth: normalizeDate(command.student.dateOfBirth),
    contactEmail: normalizeEmail(command.student.contactEmail),
    contactPhone: normalizeOptional(command.student.contactPhone, 64),
  });
  const primaryGuardian = Object.freeze({
    displayName: normalizeRequired(command.primaryGuardian.displayName, 512),
    email: normalizeEmail(command.primaryGuardian.email),
    phone: normalizeOptional(command.primaryGuardian.phone, 64),
    relationshipType: command.primaryGuardian.relationshipType,
    isLegalGuardian: command.primaryGuardian.isLegalGuardian,
  });
  if (
    !isPrimaryGuardianRelationshipType(primaryGuardian.relationshipType) ||
    typeof primaryGuardian.isLegalGuardian !== "boolean" ||
    (primaryGuardian.email === null && primaryGuardian.phone === null) ||
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
  if (value === null) return null;
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

function normalizeDate(value: unknown): string | null {
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
