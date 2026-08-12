import { randomUUID } from "node:crypto";

import {
  buildAtomicMutationEffects,
  buildAuditEvent,
  buildOutboxMessage,
  type MutationEffectBundle,
} from "../audit/contract.ts";
import type { IdentitySessionActor } from "../identity/session-repository.ts";
import { hashRequestPayload, validateIdempotencyKey } from "../shared/idempotency.ts";
import type {
  CollaboratorCapability,
  CollaboratorScope,
  ScopeGrantStatus,
} from "./contract.ts";
import {
  AccessScopePolicyError,
  isCollaboratorCapability,
  isCollaboratorScope,
  isSensitiveCollaboratorScope,
  resolveGrantExpiry,
} from "./policy.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_CODE = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;

export interface AccessScopeClock {
  nowMs(): number;
}

export interface GrantCollaboratorScopeCommand {
  readonly collaboratorUserId: string;
  readonly scope: CollaboratorScope;
  readonly capability: CollaboratorCapability;
  readonly expiresAtMs: number | null;
  readonly requestReason: string | null;
  readonly requestId: string;
  readonly idempotencyKey: string;
}

export interface GrantCollaboratorScopeResult {
  readonly collaboratorId: string;
  readonly grantId: string;
  readonly scope: CollaboratorScope;
  readonly capability: CollaboratorCapability;
  readonly status: "pending_approval" | "active";
  readonly startsAtMs: number;
  readonly expiresAtMs: number;
  readonly recordVersion: 1;
}

export interface RevokeCollaboratorScopeCommand {
  readonly expectedRecordVersion: number;
  readonly reason: string;
  readonly requestId: string;
  readonly idempotencyKey: string;
}

export interface RevokeCollaboratorScopeResult {
  readonly collaboratorId: string;
  readonly grantId: string;
  readonly status: "revoked";
  readonly recordVersion: number;
}

export interface AccessScopeRepository {
  /**
   * Production adapters must resolve the current Primary Advisor, active
   * case, and target Advisor binding before atomically writing collaborator,
   * grant, idempotency, audit, and outbox rows.
   */
  grantCollaboratorScope(input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly caseId: string;
    readonly collaboratorUserId: string;
    readonly collaboratorId: string;
    readonly grantId: string;
    readonly scope: CollaboratorScope;
    readonly capability: CollaboratorCapability;
    readonly status: "pending_approval" | "active";
    readonly startsAtMs: number;
    readonly expiresAtMs: number;
    readonly requestReason: string | null;
    readonly requestId: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly createdAtMs: number;
    readonly effects: MutationEffectBundle;
  }): Promise<GrantCollaboratorScopeResult>;
  /**
   * Production adapters must lock and verify the active Primary Advisor plus
   * grant/collaborator/case tuple before comparing the version and revoking.
   */
  revokeCollaboratorScope(input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly caseId: string;
    readonly collaboratorId: string;
    readonly grantId: string;
    readonly expectedRecordVersion: number;
    readonly reason: string;
    readonly requestId: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly revokedAtMs: number;
    readonly effects: MutationEffectBundle;
  }): Promise<RevokeCollaboratorScopeResult>;
}

export type AccessScopeErrorCode =
  | "COLLABORATOR_SCOPE_INVALID"
  | "COLLABORATOR_SCOPE_IDEMPOTENCY_KEY_REUSED"
  | "COLLABORATOR_SCOPE_IDEMPOTENCY_IN_PROGRESS"
  | "COLLABORATOR_SCOPE_DUPLICATE"
  | "COLLABORATOR_PRIMARY_ADVISOR_REQUIRED"
  | "COLLABORATOR_TARGET_ADVISOR_REQUIRED"
  | "COLLABORATOR_CASE_NOT_ACTIVE"
  | "COLLABORATOR_SCOPE_STALE_VERSION"
  | "COLLABORATOR_SCOPE_NOT_ACTIVE";

export class AccessScopeError extends Error {
  readonly code: AccessScopeErrorCode;

  constructor(code: AccessScopeErrorCode) {
    super(`Collaborator scope command rejected ${code}.`);
    this.name = "AccessScopeError";
    this.code = code;
  }
}

export interface AccessScopeServiceOptions {
  readonly repository: AccessScopeRepository;
  readonly clock?: AccessScopeClock;
  readonly createId?: () => string;
}

/**
 * Access owns collaborator and scope-grant mutation policy. The repository is
 * the transaction boundary because authorization facts can change concurrently.
 */
export class AccessScopeService {
  private readonly repository: AccessScopeRepository;
  private readonly clock: AccessScopeClock;
  private readonly createId: () => string;

  constructor(options: AccessScopeServiceOptions) {
    this.repository = options.repository;
    this.clock = options.clock ?? { nowMs: () => Date.now() };
    this.createId = options.createId ?? randomUUID;
  }

  async grantCollaboratorScope(input: {
    readonly actor: IdentitySessionActor;
    readonly caseId: string;
    readonly command: GrantCollaboratorScopeCommand;
  }): Promise<GrantCollaboratorScopeResult> {
    assertGrantInput(input);
    const startsAtMs = this.clock.nowMs();
    let expiresAtMs: number;
    try {
      expiresAtMs = resolveGrantExpiry({
        startsAtMs,
        requestedExpiresAtMs: input.command.expiresAtMs,
      });
    } catch (error) {
      if (error instanceof AccessScopePolicyError) {
        throw new AccessScopeError("COLLABORATOR_SCOPE_INVALID");
      }
      throw error;
    }

    const collaboratorId = this.createId();
    const grantId = this.createId();
    const auditId = this.createId();
    const outboxId = this.createId();
    for (const id of [collaboratorId, grantId, auditId, outboxId]) assertUuid(id);

    const status: GrantCollaboratorScopeResult["status"] = isSensitiveCollaboratorScope(
      input.command.scope,
    )
      ? "pending_approval"
      : "active";
    const occurredAt = new Date(startsAtMs).toISOString();
    const eventType = `access.scope_grant.${input.command.scope}.${input.command.capability}.created`;
    const audit = buildAuditEvent({
      id: auditId,
      organizationId: input.actor.organizationId,
      actorUserId: input.actor.userId,
      actorKind: "user",
      eventType,
      eventVersion: 1,
      action: "create",
      resourceType: "ScopeGrant",
      resourceId: grantId,
      outcome: "succeeded",
      requestId: input.command.requestId,
      occurredAt,
      metadata: {
        effect_type: "scope_grant_created",
        record_version: 1,
        status,
      },
    });
    const outbox = buildOutboxMessage({
      id: outboxId,
      auditEventId: auditId,
      organizationId: input.actor.organizationId,
      aggregateType: "ScopeGrant",
      aggregateId: grantId,
      eventType,
      eventVersion: 1,
      idempotencyKey: `scope-grant-${outboxId}`,
      requestId: input.command.requestId,
      payload: {
        aggregate_id: grantId,
        effect_type: "scope_grant_created",
        request_id: input.command.requestId,
        status,
      },
      availableAt: occurredAt,
      createdAt: occurredAt,
    });

    return this.repository.grantCollaboratorScope({
      organizationId: input.actor.organizationId,
      actorUserId: input.actor.userId,
      caseId: input.caseId,
      collaboratorUserId: input.command.collaboratorUserId,
      collaboratorId,
      grantId,
      scope: input.command.scope,
      capability: input.command.capability,
      status,
      startsAtMs,
      expiresAtMs,
      requestReason: input.command.requestReason,
      requestId: input.command.requestId,
      idempotencyKey: input.command.idempotencyKey,
      requestHash: hashRequestPayload({
        capability: input.command.capability,
        caseId: input.caseId,
        collaboratorUserId: input.command.collaboratorUserId,
        expiresAtMs: input.command.expiresAtMs,
        requestReason: input.command.requestReason,
        scope: input.command.scope,
      }),
      createdAtMs: startsAtMs,
      effects: buildAtomicMutationEffects({ audit, outbox }),
    });
  }

  async revokeCollaboratorScope(input: {
    readonly actor: IdentitySessionActor;
    readonly caseId: string;
    readonly collaboratorId: string;
    readonly grantId: string;
    readonly command: RevokeCollaboratorScopeCommand;
  }): Promise<RevokeCollaboratorScopeResult> {
    assertRevokeInput(input);
    const revokedAtMs = this.clock.nowMs();
    if (!Number.isSafeInteger(revokedAtMs) || revokedAtMs <= 0) {
      throw new AccessScopeError("COLLABORATOR_SCOPE_INVALID");
    }

    const auditId = this.createId();
    const outboxId = this.createId();
    for (const id of [auditId, outboxId]) assertUuid(id);
    const occurredAt = new Date(revokedAtMs).toISOString();
    const eventType = "access.scope_grant.revoked";
    const audit = buildAuditEvent({
      id: auditId,
      organizationId: input.actor.organizationId,
      actorUserId: input.actor.userId,
      actorKind: "user",
      eventType,
      eventVersion: 1,
      action: "revoke",
      resourceType: "ScopeGrant",
      resourceId: input.grantId,
      outcome: "succeeded",
      requestId: input.command.requestId,
      occurredAt,
      metadata: {
        effect_type: "scope_grant_revoked",
        next_version: input.command.expectedRecordVersion + 1,
        status: "revoked",
      },
    });
    const outbox = buildOutboxMessage({
      id: outboxId,
      auditEventId: auditId,
      organizationId: input.actor.organizationId,
      aggregateType: "ScopeGrant",
      aggregateId: input.grantId,
      eventType,
      eventVersion: 1,
      idempotencyKey: `scope-revoke-${outboxId}`,
      requestId: input.command.requestId,
      payload: {
        aggregate_id: input.grantId,
        effect_type: "scope_grant_revoked",
        request_id: input.command.requestId,
        status: "revoked",
      },
      availableAt: occurredAt,
      createdAt: occurredAt,
    });

    return this.repository.revokeCollaboratorScope({
      organizationId: input.actor.organizationId,
      actorUserId: input.actor.userId,
      caseId: input.caseId,
      collaboratorId: input.collaboratorId,
      grantId: input.grantId,
      expectedRecordVersion: input.command.expectedRecordVersion,
      reason: input.command.reason,
      requestId: input.command.requestId,
      idempotencyKey: input.command.idempotencyKey,
      requestHash: hashRequestPayload({
        caseId: input.caseId,
        collaboratorId: input.collaboratorId,
        expectedRecordVersion: input.command.expectedRecordVersion,
        grantId: input.grantId,
        reason: input.command.reason,
      }),
      revokedAtMs,
      effects: buildAtomicMutationEffects({ audit, outbox }),
    });
  }
}

function assertGrantInput(input: {
  readonly actor: IdentitySessionActor;
  readonly caseId: string;
  readonly command: GrantCollaboratorScopeCommand;
}): void {
  if (
    !UUID.test(input.actor.organizationId) ||
    !UUID.test(input.actor.userId) ||
    !UUID.test(input.caseId) ||
    !UUID.test(input.command.collaboratorUserId) ||
    !isCollaboratorScope(input.command.scope) ||
    !isCollaboratorCapability(input.command.capability) ||
    !SAFE_CODE.test(input.command.requestId) ||
    (input.command.requestReason !== null &&
      (typeof input.command.requestReason !== "string" ||
        input.command.requestReason.trim().length === 0 ||
        input.command.requestReason.length > 1_024))
  ) {
    throw new AccessScopeError("COLLABORATOR_SCOPE_INVALID");
  }
  if (isSensitiveCollaboratorScope(input.command.scope) && input.command.requestReason === null) {
    throw new AccessScopeError("COLLABORATOR_SCOPE_INVALID");
  }
  try {
    validateIdempotencyKey(input.command.idempotencyKey);
  } catch {
    throw new AccessScopeError("COLLABORATOR_SCOPE_INVALID");
  }
}

function assertRevokeInput(input: {
  readonly actor: IdentitySessionActor;
  readonly caseId: string;
  readonly collaboratorId: string;
  readonly grantId: string;
  readonly command: RevokeCollaboratorScopeCommand;
}): void {
  if (
    !UUID.test(input.actor.organizationId) ||
    !UUID.test(input.actor.userId) ||
    !UUID.test(input.caseId) ||
    !UUID.test(input.collaboratorId) ||
    !UUID.test(input.grantId) ||
    !Number.isSafeInteger(input.command.expectedRecordVersion) ||
    input.command.expectedRecordVersion < 1 ||
    typeof input.command.reason !== "string" ||
    input.command.reason.trim().length === 0 ||
    input.command.reason.length > 1_024 ||
    !SAFE_CODE.test(input.command.requestId)
  ) {
    throw new AccessScopeError("COLLABORATOR_SCOPE_INVALID");
  }
  try {
    validateIdempotencyKey(input.command.idempotencyKey);
  } catch {
    throw new AccessScopeError("COLLABORATOR_SCOPE_INVALID");
  }
}

function assertUuid(value: string): void {
  if (!UUID.test(value)) throw new AccessScopeError("COLLABORATOR_SCOPE_INVALID");
}
