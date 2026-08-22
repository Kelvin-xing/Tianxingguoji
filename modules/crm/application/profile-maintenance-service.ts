import { randomUUID } from "node:crypto";

import { evaluateBootstrapAuthorization, type OrganizationRole } from "../../access/public.ts";
import {
  buildAtomicMutationEffects,
  buildAuditEvent,
  buildOutboxMessage,
  type MutationEffectBundle,
} from "../../audit/public.ts";
import type { IdentitySessionActor } from "../../identity/public.ts";
import { hashRequestPayload, validateIdempotencyKey } from "../../shared/public.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface StudentProfileUpdateCommand {
  readonly studentId: string;
  readonly displayName: string;
  readonly dateOfBirth: string | null;
  readonly contactEmail: string | null;
  readonly contactPhone: string | null;
  readonly expectedRecordVersion: number;
  readonly requestId: string;
  readonly idempotencyKey: string;
}

export interface GuardianProfileUpdateCommand {
  readonly guardianId: string;
  readonly displayName: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly expectedRecordVersion: number;
  readonly requestId: string;
  readonly idempotencyKey: string;
}

export interface ProfileUpdateAcknowledgement {
  readonly id: string;
  readonly recordVersion: number;
  readonly updatedAt: string;
}

interface ProfileRepositoryInput {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly actorRole: OrganizationRole;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly effects: MutationEffectBundle;
}

export interface ProfileMaintenanceRepository {
  updateStudent(input: ProfileRepositoryInput & {
    readonly studentId: string;
    readonly displayName: string;
    readonly dateOfBirth: string | null;
    readonly contactEmail: string | null;
    readonly contactPhone: string | null;
    readonly expectedRecordVersion: number;
  }): Promise<ProfileUpdateAcknowledgement>;
  updateGuardian(input: ProfileRepositoryInput & {
    readonly guardianId: string;
    readonly displayName: string;
    readonly email: string | null;
    readonly phone: string | null;
    readonly expectedRecordVersion: number;
  }): Promise<ProfileUpdateAcknowledgement>;
}

export type ProfileMaintenanceErrorCode =
  | "PROFILE_MAINTENANCE_FORBIDDEN"
  | "PROFILE_MAINTENANCE_INVALID"
  | "PROFILE_MAINTENANCE_NOT_FOUND"
  | "PROFILE_MAINTENANCE_INACTIVE"
  | "PROFILE_MAINTENANCE_STALE_VERSION"
  | "PROFILE_MAINTENANCE_IDEMPOTENCY_CONFLICT"
  | "PROFILE_MAINTENANCE_IDEMPOTENCY_IN_PROGRESS"
  | "PROFILE_MAINTENANCE_UNAVAILABLE";

const ERROR_CODES = new Set<ProfileMaintenanceErrorCode>([
  "PROFILE_MAINTENANCE_FORBIDDEN",
  "PROFILE_MAINTENANCE_INVALID",
  "PROFILE_MAINTENANCE_NOT_FOUND",
  "PROFILE_MAINTENANCE_INACTIVE",
  "PROFILE_MAINTENANCE_STALE_VERSION",
  "PROFILE_MAINTENANCE_IDEMPOTENCY_CONFLICT",
  "PROFILE_MAINTENANCE_IDEMPOTENCY_IN_PROGRESS",
  "PROFILE_MAINTENANCE_UNAVAILABLE",
]);

export class ProfileMaintenanceError extends Error {
  readonly code: ProfileMaintenanceErrorCode;

  constructor(code: ProfileMaintenanceErrorCode) {
    super(`Profile maintenance rejected ${code}.`);
    this.name = "ProfileMaintenanceError";
    this.code = code;
  }
}

export function isProfileMaintenanceError(
  error: unknown,
  code?: ProfileMaintenanceErrorCode,
): error is ProfileMaintenanceError {
  if (!(error instanceof Error) || error.name !== "ProfileMaintenanceError") return false;
  const candidate = (error as Error & { readonly code?: unknown }).code;
  if (typeof candidate !== "string" || !ERROR_CODES.has(candidate as ProfileMaintenanceErrorCode)) {
    return false;
  }
  return code === undefined || candidate === code;
}

export class ProfileMaintenanceService {
  private readonly repository: ProfileMaintenanceRepository;
  private readonly createId: () => string;
  private readonly nowMs: () => number;

  constructor(
    repository: ProfileMaintenanceRepository,
    createId: () => string = randomUUID,
    nowMs: () => number = Date.now,
  ) {
    this.repository = repository;
    this.createId = createId;
    this.nowMs = nowMs;
  }

  async updateStudent(input: {
    readonly actor: IdentitySessionActor;
    readonly command: StudentProfileUpdateCommand;
  }): Promise<ProfileUpdateAcknowledgement> {
    assertAuthorized(input.actor);
    const command = normalizeStudentCommand(input.command);
    const requestHash = hashRequestPayload({
      studentId: command.studentId,
      displayName: command.displayName,
      dateOfBirth: command.dateOfBirth,
      contactEmail: command.contactEmail,
      contactPhone: command.contactPhone,
      expectedRecordVersion: command.expectedRecordVersion,
    });
    return await this.update(input.actor, command.requestId, command.expectedRecordVersion, "Student",
      "crm.student_profile_updated", {
        requestHash,
        resourceId: command.studentId,
        idempotencyKey: command.idempotencyKey,
        invoke: (effects) => this.repository.updateStudent({
          organizationId: input.actor.organizationId,
          actorUserId: input.actor.userId,
          actorRole: input.actor.role,
          ...command,
          requestHash,
          effects,
        }),
      });
  }

  async updateGuardian(input: {
    readonly actor: IdentitySessionActor;
    readonly command: GuardianProfileUpdateCommand;
  }): Promise<ProfileUpdateAcknowledgement> {
    assertAuthorized(input.actor);
    const command = normalizeGuardianCommand(input.command);
    const requestHash = hashRequestPayload({
      guardianId: command.guardianId,
      displayName: command.displayName,
      email: command.email,
      phone: command.phone,
      expectedRecordVersion: command.expectedRecordVersion,
    });
    return await this.update(input.actor, command.requestId, command.expectedRecordVersion, "Guardian",
      "crm.guardian_profile_updated", {
        requestHash,
        resourceId: command.guardianId,
        idempotencyKey: command.idempotencyKey,
        invoke: (effects) => this.repository.updateGuardian({
          organizationId: input.actor.organizationId,
          actorUserId: input.actor.userId,
          actorRole: input.actor.role,
          ...command,
          requestHash,
          effects,
        }),
      });
  }

  private async update(
    actor: IdentitySessionActor,
    requestId: string,
    expectedRecordVersion: number,
    resourceType: "Student" | "Guardian",
    eventType: string,
    input: {
      readonly requestHash: string;
      readonly resourceId: string;
      readonly idempotencyKey: string;
      readonly invoke: (effects: MutationEffectBundle) => Promise<ProfileUpdateAcknowledgement>;
    },
  ): Promise<ProfileUpdateAcknowledgement> {
    const ids = [this.createId(), this.createId()];
    if (!ids.every((id) => UUID.test(id))) throw invalid();
    const occurredAtMs = this.nowMs();
    if (!Number.isFinite(occurredAtMs) || occurredAtMs <= 0) throw invalid();
    const occurredAt = new Date(occurredAtMs).toISOString();
    const nextVersion = expectedRecordVersion + 1;
    const audit = buildAuditEvent({
      id: ids[0]!, organizationId: actor.organizationId, actorUserId: actor.userId,
      actorKind: "user", eventType, eventVersion: 1, action: "update",
      resourceType, resourceId: input.resourceId, outcome: "succeeded", requestId,
      occurredAt, metadata: { effect_type: eventType, previous_version: expectedRecordVersion,
        record_version: nextVersion, status: "active" },
    });
    const outbox = buildOutboxMessage({
      id: ids[1]!, auditEventId: ids[0]!, organizationId: actor.organizationId,
      aggregateType: resourceType, aggregateId: input.resourceId, eventType, eventVersion: 1,
      idempotencyKey: `crm-profile-${ids[1]}`, requestId,
      payload: { aggregate_id: input.resourceId, effect_type: eventType,
        record_version: nextVersion, request_id: requestId, status: "active" },
      availableAt: occurredAt, createdAt: occurredAt,
    });
    try {
      return await input.invoke(buildAtomicMutationEffects({ audit, outbox }));
    } catch (error) {
      if (isProfileMaintenanceError(error)) throw error;
      throw error;
    }
  }
}

function assertAuthorized(actor: IdentitySessionActor): void {
  if (!UUID.test(actor.organizationId) || !UUID.test(actor.userId) ||
      !evaluateBootstrapAuthorization(actor.role, { capability: "students.profiles.manage" }).allowed) {
    throw new ProfileMaintenanceError("PROFILE_MAINTENANCE_FORBIDDEN");
  }
}

function normalizeStudentCommand(command: StudentProfileUpdateCommand): StudentProfileUpdateCommand {
  validateCommon(command.studentId, command.expectedRecordVersion, command.requestId,
    command.idempotencyKey);
  return Object.freeze({
    studentId: command.studentId,
    displayName: required(command.displayName),
    dateOfBirth: date(command.dateOfBirth),
    contactEmail: email(command.contactEmail),
    contactPhone: optional(command.contactPhone, 64),
    expectedRecordVersion: command.expectedRecordVersion,
    requestId: command.requestId,
    idempotencyKey: command.idempotencyKey,
  });
}

function normalizeGuardianCommand(command: GuardianProfileUpdateCommand): GuardianProfileUpdateCommand {
  validateCommon(command.guardianId, command.expectedRecordVersion, command.requestId,
    command.idempotencyKey);
  const normalized = Object.freeze({
    guardianId: command.guardianId,
    displayName: required(command.displayName),
    email: email(command.email),
    phone: optional(command.phone, 64),
    expectedRecordVersion: command.expectedRecordVersion,
    requestId: command.requestId,
    idempotencyKey: command.idempotencyKey,
  });
  if (normalized.email === null && normalized.phone === null) throw invalid();
  return normalized;
}

function validateCommon(id: string, version: number, requestId: string, key: string): void {
  if (!UUID.test(id) || !Number.isSafeInteger(version) || version < 1 || !REQUEST_ID.test(requestId)) {
    throw invalid();
  }
  try { validateIdempotencyKey(key); } catch { throw invalid(); }
}

function required(value: unknown): string {
  if (typeof value !== "string") throw invalid();
  const result = value.trim();
  if (!result || result.length > 512) throw invalid();
  return result;
}

function optional(value: unknown, maximum: number): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw invalid();
  const result = value.trim();
  if (!result) return null;
  if (result.length > maximum) throw invalid();
  return result;
}

function email(value: unknown): string | null {
  const result = optional(value, 320)?.toLowerCase() ?? null;
  if (result !== null && !EMAIL.test(result)) throw invalid();
  return result;
}

function date(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !DATE.test(value)) throw invalid();
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw invalid();
  return value;
}

function invalid(): ProfileMaintenanceError {
  return new ProfileMaintenanceError("PROFILE_MAINTENANCE_INVALID");
}
