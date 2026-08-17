import { randomUUID } from "node:crypto";

import {
  buildAtomicMutationEffects,
  buildAuditEvent,
  buildOutboxMessage,
  type MutationEffectBundle,
} from "../../audit/public.ts";
import { hashRequestPayload, validateIdempotencyKey } from "../../shared/public.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_CODE = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;

export const COGNITO_REVOKE_MAX_ATTEMPTS = 3;
export const COGNITO_REVOKE_RETRY_BACKOFF_MS = Object.freeze([60_000, 300_000] as const);
export const COGNITO_REVOKE_LEASE_MS = 30_000;

export type CognitoRevokeWorkState = "pending" | "processing" | "delivered" | "dead_letter";
export type CognitoRevokeReceiptOutcome = "delivered" | "failed";

export interface IdentityRevokeClock {
  nowMs(): number;
}

export interface DisableUserResult {
  readonly userId: string;
  readonly organizationId: string;
  readonly recordVersion: number;
  readonly sessionVersion: number;
  readonly revokeWorkId: string;
  readonly status: "pending";
}

export interface CognitoRevokeReceiptSummary {
  readonly outcome: CognitoRevokeReceiptOutcome;
  readonly attemptCount: number;
  readonly failureCode: string | null;
}

export interface CognitoRevokeStatus {
  readonly revokeWorkId: string;
  readonly status: CognitoRevokeWorkState;
  readonly attemptCount: number;
  readonly receipt: CognitoRevokeReceiptSummary | null;
}

export interface CognitoRevokeLease {
  readonly revokeWorkId: string;
  readonly leaseVersion: number;
  readonly providerSubject: string;
  readonly attemptCount: number;
}

export interface IdentityRevokeRepository {
  /**
   * The implementation owns a single transaction containing the User state,
   * session invalidation, audit event, and outbox row. It must never call a
   * provider from that transaction.
   */
  disableUser(input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly targetUserId: string;
    readonly expectedRecordVersion: number;
    readonly reasonCode: string;
    readonly requestId: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly disabledAtMs: number;
    readonly effects: MutationEffectBundle;
  }): Promise<DisableUserResult>;
  findCognitoRevokeStatus(input: { readonly revokeWorkId: string }): Promise<CognitoRevokeStatus>;
  claimDueCognitoRevoke(input: {
    readonly nowMs: number;
    readonly leaseDurationMs: number;
  }): Promise<CognitoRevokeLease | null>;
  recordCognitoRevokeDelivered(input: {
    readonly revokeWorkId: string;
    readonly leaseVersion: number;
    readonly completedAtMs: number;
  }): Promise<void>;
  recordCognitoRevokeRetry(input: {
    readonly revokeWorkId: string;
    readonly leaseVersion: number;
    readonly attemptedAtMs: number;
    readonly nextAvailableAtMs: number;
    readonly errorCode: string;
  }): Promise<void>;
  recordCognitoRevokeDeadLetter(input: {
    readonly revokeWorkId: string;
    readonly leaseVersion: number;
    readonly completedAtMs: number;
    readonly errorCode: string;
  }): Promise<void>;
}

export type IdentityRevokeErrorCode =
  | "REVOKE_COMMAND_INVALID"
  | "REVOKE_STATUS_NOT_FOUND"
  | "REVOKE_LEASE_CONFLICT"
  | "REVOKE_IDEMPOTENCY_KEY_REUSED"
  | "REVOKE_USER_NOT_FOUND"
  | "REVOKE_USER_ORGANIZATION_MISMATCH"
  | "REVOKE_STALE_VERSION"
  | "REVOKE_USER_NOT_ACTIVE"
  | "REVOKE_USER_ALREADY_DISABLED"
  | "REVOKE_PROVIDER_IDENTITY_MISSING";

export class IdentityRevokeError extends Error {
  readonly code: IdentityRevokeErrorCode;

  constructor(code: IdentityRevokeErrorCode) {
    super(`Identity revoke workflow rejected ${code}.`);
    this.name = "IdentityRevokeError";
    this.code = code;
  }
}

export interface IdentityRevokeWorkflowOptions {
  readonly repository: IdentityRevokeRepository;
  readonly clock?: IdentityRevokeClock;
  readonly createId?: () => string;
}

/**
 * Public Identity-module command seam for immediate account disable and the
 * query seam Operations uses to inspect its later provider effect.
 */
export class IdentityRevokeWorkflow {
  private readonly repository: IdentityRevokeRepository;
  private readonly clock: IdentityRevokeClock;
  private readonly createId: () => string;

  constructor(options: IdentityRevokeWorkflowOptions) {
    this.repository = options.repository;
    this.clock = options.clock ?? { nowMs: () => Date.now() };
    this.createId = options.createId ?? randomUUID;
  }

  async disableUser(input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly targetUserId: string;
    readonly expectedRecordVersion: number;
    readonly reasonCode: string;
    readonly requestId: string;
    readonly idempotencyKey: string;
  }): Promise<DisableUserResult> {
    assertDisableInput(input);
    const nowMs = this.clock.nowMs();
    const occurredAt = new Date(nowMs).toISOString();
    const auditId = this.createId();
    const outboxId = this.createId();
    assertUuid(auditId);
    assertUuid(outboxId);

    const audit = buildAuditEvent({
      id: auditId,
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      actorKind: "user",
      eventType: "identity.user_disabled",
      eventVersion: 1,
      action: "disable",
      resourceType: "IdentityUser",
      resourceId: input.targetUserId,
      outcome: "succeeded",
      requestId: input.requestId,
      occurredAt,
      metadata: {
        reason_code: input.reasonCode,
        effect_type: "cognito.revoke",
        status: "pending",
      },
    });
    const outbox = buildOutboxMessage({
      id: outboxId,
      auditEventId: auditId,
      organizationId: input.organizationId,
      aggregateType: "IdentityUser",
      aggregateId: input.targetUserId,
      eventType: "identity.user_disabled",
      eventVersion: 1,
      idempotencyKey: `cognito-revoke-${outboxId}`,
      requestId: input.requestId,
      payload: {
        aggregate_id: input.targetUserId,
        record_version: input.expectedRecordVersion + 1,
        request_id: input.requestId,
        effect_type: "cognito.revoke",
        operation: "identity.user.disable",
        status: "pending",
      },
      availableAt: occurredAt,
      createdAt: occurredAt,
    });

    return this.repository.disableUser({
      ...input,
      requestHash: hashRequestPayload({
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        targetUserId: input.targetUserId,
        expectedRecordVersion: input.expectedRecordVersion,
        reasonCode: input.reasonCode,
      }),
      disabledAtMs: nowMs,
      effects: buildAtomicMutationEffects({ audit, outbox }),
    });
  }

  async getCognitoRevokeStatus(input: {
    readonly revokeWorkId: string;
  }): Promise<CognitoRevokeStatus> {
    assertUuid(input.revokeWorkId);
    return this.repository.findCognitoRevokeStatus(input);
  }
}

export function retryAvailableAtMs(input: {
  readonly attemptedAtMs: number;
  readonly completedAttemptCount: number;
}): number {
  if (
    !Number.isSafeInteger(input.completedAttemptCount) ||
    input.completedAttemptCount < 1 ||
    input.completedAttemptCount >= COGNITO_REVOKE_MAX_ATTEMPTS ||
    !Number.isFinite(input.attemptedAtMs)
  ) {
    throw new IdentityRevokeError("REVOKE_COMMAND_INVALID");
  }
  return input.attemptedAtMs + COGNITO_REVOKE_RETRY_BACKOFF_MS[input.completedAttemptCount - 1]!;
}

function assertDisableInput(input: {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly targetUserId: string;
  readonly expectedRecordVersion: number;
  readonly reasonCode: string;
  readonly requestId: string;
  readonly idempotencyKey: string;
}): void {
  assertUuid(input.organizationId);
  assertUuid(input.actorUserId);
  assertUuid(input.targetUserId);
  if (!Number.isSafeInteger(input.expectedRecordVersion) || input.expectedRecordVersion < 1) {
    throw new IdentityRevokeError("REVOKE_COMMAND_INVALID");
  }
  if (!SAFE_CODE.test(input.reasonCode) || !SAFE_CODE.test(input.requestId)) {
    throw new IdentityRevokeError("REVOKE_COMMAND_INVALID");
  }
  try {
    validateIdempotencyKey(input.idempotencyKey);
  } catch {
    throw new IdentityRevokeError("REVOKE_COMMAND_INVALID");
  }
}

function assertUuid(value: string): void {
  if (!UUID.test(value)) throw new IdentityRevokeError("REVOKE_COMMAND_INVALID");
}
