import { randomUUID } from "node:crypto";

import {
  buildAtomicMutationEffects,
  buildAuditEvent,
  buildOutboxMessage,
  type MutationEffectBundle,
} from "../../audit/public.ts";
import { hashRequestPayload, validateIdempotencyKey } from "../../shared/public.ts";
import {
  hasRequestCapability,
  type AccessContext,
} from "../domain/authorization.ts";
import {
  isOrganizationRole,
  type EmploymentType,
  type Release1OrganizationRole,
} from "../domain/contract.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ACCESS_VERSION = /^v1:[1-9]\d*:\d+:(?:none|[0-9a-f@,.-]+)$/i;

export interface OwnEmployeeProfile {
  readonly userId: string;
  readonly normalizedEmail: string;
  readonly displayName: string | null;
  readonly employmentType: EmploymentType | null;
  readonly recordVersion: number | null;
  readonly updatedAt: string;
}

export interface MemberMutationReceipt {
  readonly userId: string;
  readonly receiptId: string;
  readonly replayed: boolean;
}

export interface MemberManagementRepository {
  getOwnProfile(input: Readonly<{
    organizationId: string;
    actorUserId: string;
  }>): Promise<OwnEmployeeProfile>;
  updateOwnDisplayName(input: Readonly<{
    organizationId: string;
    actorUserId: string;
    displayName: string;
    expectedProfileRecordVersion: number | null;
    requestId: string;
    idempotencyKey: string;
    idempotencyId: string;
    requestHash: string;
    occurredAt: string;
    effects: MutationEffectBundle;
  }>): Promise<MemberMutationReceipt>;
  updateMemberAccess(input: Readonly<{
    organizationId: string;
    actorUserId: string;
    targetUserId: string;
    displayName: string;
    employmentType: EmploymentType;
    roles: readonly Release1OrganizationRole[];
    expectedAccessVersion: string;
    roleBindingIds: Readonly<Record<Release1OrganizationRole, string>>;
    requestId: string;
    idempotencyKey: string;
    idempotencyId: string;
    requestHash: string;
    occurredAt: string;
    effects: MutationEffectBundle;
  }>): Promise<MemberMutationReceipt>;
}

export type MemberManagementErrorCode =
  | "FORBIDDEN"
  | "INVALID"
  | "NOT_FOUND"
  | "STALE_VERSION"
  | "ROLE_CONFLICT"
  | "LAST_FOUNDER_REQUIRED"
  | "PROFILE_SETUP_REQUIRED"
  | "IDEMPOTENCY_CONFLICT"
  | "UNAVAILABLE";

export class MemberManagementError extends Error {
  readonly code: MemberManagementErrorCode;

  constructor(code: MemberManagementErrorCode) {
    super(`Member management rejected ${code}.`);
    this.name = "MemberManagementError";
    this.code = code;
  }
}

export function isMemberManagementError(
  error: unknown,
  code?: MemberManagementErrorCode,
): error is MemberManagementError {
  return error instanceof MemberManagementError && (code === undefined || error.code === code);
}

export class MemberManagementService {
  private readonly repository: MemberManagementRepository;
  private readonly createId: () => string;
  private readonly now: () => number;

  constructor(input: Readonly<{
    repository: MemberManagementRepository;
    createId?: () => string;
    now?: () => number;
  }>) {
    this.repository = input.repository;
    this.createId = input.createId ?? randomUUID;
    this.now = input.now ?? Date.now;
  }

  getOwnProfile(actor: AccessContext): Promise<OwnEmployeeProfile> {
    return this.repository.getOwnProfile({
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
    });
  }

  updateOwnDisplayName(input: Readonly<{
    actor: AccessContext;
    command: Readonly<{
      displayName: string;
      expectedProfileRecordVersion: number | null;
      requestId: string;
      idempotencyKey: string;
    }>;
  }>): Promise<MemberMutationReceipt> {
    const displayName = validateDisplayName(input.command.displayName);
    validateExpectedProfileVersion(input.command.expectedProfileRecordVersion);
    validateCommandEnvelope(input.command.requestId, input.command.idempotencyKey);
    return this.repository.updateOwnDisplayName({
      organizationId: input.actor.organizationId,
      actorUserId: input.actor.userId,
      displayName,
      expectedProfileRecordVersion: input.command.expectedProfileRecordVersion,
      requestId: input.command.requestId,
      idempotencyKey: input.command.idempotencyKey,
      idempotencyId: this.createId(),
      requestHash: hashRequestPayload({
        display_name: displayName,
        expected_profile_record_version: input.command.expectedProfileRecordVersion,
      }),
      occurredAt: occurredAt(this.now()),
      effects: this.effects({
        actor: input.actor,
        targetUserId: input.actor.userId,
        eventType: "access.employee_profile.display_name.updated",
        action: "update_display_name",
        effectType: "employee_profile_display_name_updated",
        requestId: input.command.requestId,
      }),
    });
  }

  updateMemberAccess(input: Readonly<{
    actor: AccessContext;
    targetUserId: string;
    command: Readonly<{
      displayName: string;
      employmentType: EmploymentType;
      roles: readonly string[];
      expectedAccessVersion: string;
      requestId: string;
      idempotencyKey: string;
    }>;
  }>): Promise<MemberMutationReceipt> {
    if (!hasRequestCapability(input.actor, "access.manage")) {
      throw new MemberManagementError("FORBIDDEN");
    }
    if (!UUID.test(input.targetUserId) || !ACCESS_VERSION.test(input.command.expectedAccessVersion)) {
      throw new MemberManagementError("INVALID");
    }
    const displayName = validateDisplayName(input.command.displayName);
    const roles = validateRoles(input.command.roles, input.command.employmentType);
    validateCommandEnvelope(input.command.requestId, input.command.idempotencyKey);
    const roleBindingIds = Object.freeze({
      founder: this.createId(),
      admin: this.createId(),
      advisor: this.createId(),
      contractor: this.createId(),
    });
    return this.repository.updateMemberAccess({
      organizationId: input.actor.organizationId,
      actorUserId: input.actor.userId,
      targetUserId: input.targetUserId,
      displayName,
      employmentType: input.command.employmentType,
      roles,
      expectedAccessVersion: input.command.expectedAccessVersion,
      roleBindingIds,
      requestId: input.command.requestId,
      idempotencyKey: input.command.idempotencyKey,
      idempotencyId: this.createId(),
      requestHash: hashRequestPayload({
        display_name: displayName,
        employment_type: input.command.employmentType,
        expected_access_version: input.command.expectedAccessVersion,
        roles,
        target_user_id: input.targetUserId,
      }),
      occurredAt: occurredAt(this.now()),
      effects: this.effects({
        actor: input.actor,
        targetUserId: input.targetUserId,
        eventType: "access.organization_member.access.updated",
        action: "update_member_access",
        effectType: "organization_member_access_updated",
        requestId: input.command.requestId,
      }),
    });
  }

  private effects(input: Readonly<{
    actor: AccessContext;
    targetUserId: string;
    eventType: string;
    action: string;
    effectType: string;
    requestId: string;
  }>): MutationEffectBundle {
    const auditId = this.createId();
    const outboxId = this.createId();
    const timestamp = occurredAt(this.now());
    const audit = buildAuditEvent({
      id: auditId,
      organizationId: input.actor.organizationId,
      actorUserId: input.actor.userId,
      actorKind: "user",
      eventType: input.eventType,
      eventVersion: 1,
      action: input.action,
      resourceType: "OrganizationMember",
      resourceId: input.targetUserId,
      outcome: "succeeded",
      requestId: input.requestId,
      occurredAt: timestamp,
      metadata: { effect_type: input.effectType, status: "active" },
    });
    const outbox = buildOutboxMessage({
      id: outboxId,
      auditEventId: auditId,
      organizationId: input.actor.organizationId,
      aggregateType: "OrganizationMember",
      aggregateId: input.targetUserId,
      eventType: input.eventType,
      eventVersion: 1,
      idempotencyKey: `member-${outboxId}`,
      requestId: input.requestId,
      payload: {
        aggregate_id: input.targetUserId,
        effect_type: input.effectType,
        request_id: input.requestId,
        status: "active",
      },
      availableAt: timestamp,
      createdAt: timestamp,
    });
    return buildAtomicMutationEffects({ audit, outbox });
  }
}

function validateDisplayName(value: string): string {
  if (typeof value !== "string") throw new MemberManagementError("INVALID");
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 100) {
    throw new MemberManagementError("INVALID");
  }
  return normalized;
}

function validateExpectedProfileVersion(value: number | null): void {
  if (value !== null && (!Number.isSafeInteger(value) || value < 1)) {
    throw new MemberManagementError("INVALID");
  }
}

function validateCommandEnvelope(requestId: string, idempotencyKey: string): void {
  if (!SAFE_REQUEST_ID.test(requestId)) throw new MemberManagementError("INVALID");
  try {
    validateIdempotencyKey(idempotencyKey);
  } catch {
    throw new MemberManagementError("INVALID");
  }
}

function validateRoles(
  values: readonly string[],
  employmentType: EmploymentType,
): readonly Release1OrganizationRole[] {
  if (employmentType !== "FULL_TIME" && employmentType !== "PART_TIME") {
    throw new MemberManagementError("INVALID");
  }
  if (!Array.isArray(values) || values.some((role) => !isOrganizationRole(role))) {
    throw new MemberManagementError("INVALID");
  }
  const roles = [...new Set(values as readonly Release1OrganizationRole[])].sort();
  if (roles.length !== values.length) throw new MemberManagementError("INVALID");
  if (roles.includes("contractor") && roles.length > 1) {
    throw new MemberManagementError("ROLE_CONFLICT");
  }
  if (
    (employmentType === "FULL_TIME" && roles.includes("contractor")) ||
    (employmentType === "PART_TIME" &&
      (roles.includes("founder") || roles.includes("advisor")))
  ) {
    throw new MemberManagementError("ROLE_CONFLICT");
  }
  return Object.freeze(roles);
}

function occurredAt(now: number): string {
  if (!Number.isSafeInteger(now) || now <= 0) throw new MemberManagementError("UNAVAILABLE");
  return new Date(now).toISOString();
}
