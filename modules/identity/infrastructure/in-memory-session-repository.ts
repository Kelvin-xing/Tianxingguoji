import "server-only";

import type { OrganizationRole } from "../../access/public.ts";
import type { MutationEffectBundle } from "../../audit/public.ts";
import type { IdentitySessionActor } from "../domain/actor.ts";
import {
  evaluateInviteActivation,
  evaluateSession,
  selectAvailableSessionSlot,
  SESSION_POLICY,
  type InviteStatus,
  type SessionSlot,
} from "../domain/contract.ts";
import {
  COGNITO_REVOKE_MAX_ATTEMPTS,
  IdentityRevokeError,
  type CognitoRevokeLease,
  type CognitoRevokeReceiptSummary,
  type CognitoRevokeStatus,
  type DisableUserResult,
} from "../application/revoke-workflow.ts";
import {
  IdentityRepositoryError,
  type ClaimedInviteActivation,
  type IdentitySessionRepository,
  type InviteDeliveryReceipt,
  type InvitePersistenceInput,
  type LocalSyntheticSessionRepository,
  type StoredIdentitySession,
} from "../application/session-port.ts";

export type { IdentitySessionActor } from "../domain/actor.ts";

interface StoredInvite extends InvitePersistenceInput {
  status: InviteStatus;
  providerSubject: string | null;
  deliveryReceipt: InviteDeliveryReceipt | null;
}

interface StoredSession extends StoredIdentitySession {
  readonly secretHash: string;
  readonly sessionSlot: SessionSlot;
}

interface StoredIdentityUser {
  readonly organizationId: string;
  readonly role: OrganizationRole;
  providerSubject: string | null;
  status: "invited" | "active" | "disabled";
  recordVersion: number;
  sessionVersion: number;
}

interface StoredCognitoRevokeWork {
  readonly id: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly providerSubject: string;
  readonly requestHash: string;
  readonly idempotencyScope: string;
  status: "pending" | "processing" | "delivered" | "dead_letter";
  attemptCount: number;
  availableAtMs: number;
  leasedUntilMs: number | null;
  leaseVersion: number;
  receipt: CognitoRevokeReceiptSummary | null;
}

/**
 * Deterministic adapter for P1-03 tests. Production wiring must provide an
 * RDS-backed implementation that preserves these transition checks in SQL.
 */
export class InMemoryIdentitySessionRepository implements IdentitySessionRepository, LocalSyntheticSessionRepository {
  private readonly invites = new Map<string, StoredInvite>();
  private readonly inviteByIdempotency = new Map<string, string>();
  private readonly sessionsBySecretHash = new Map<string, StoredSession>();
  private readonly usersById = new Map<string, StoredIdentityUser>();
  private readonly revokeWorkById = new Map<string, StoredCognitoRevokeWork>();
  private readonly revokeWorkByIdempotency = new Map<string, string>();
  private readonly effectsByRevokeWorkId = new Map<string, MutationEffectBundle>();

  async createLocalSyntheticSession(input: {
    readonly userId: string;
    readonly organizationId: string;
    readonly role: OrganizationRole;
    readonly sessionId: string;
    readonly secretHash: string;
    readonly nowMs: number;
  }): Promise<IdentitySessionActor> {
    const existingUser = this.usersById.get(input.userId);
    if (existingUser && (
      existingUser.organizationId !== input.organizationId || existingUser.role !== input.role
    )) {
      throw new IdentityRepositoryError("INVITE_IDENTITY_MISMATCH");
    }

    const user: StoredIdentityUser = existingUser ?? {
      organizationId: input.organizationId,
      role: input.role,
      providerSubject: `local_${input.userId}`,
      status: "active",
      recordVersion: 1,
      sessionVersion: 1,
    };
    user.status = "active";
    this.usersById.set(input.userId, user);

    // A local role login replaces its previous browser session to keep repeated
    // development sign-ins deterministic and below the production slot limit.
    for (const session of this.sessionsBySecretHash.values()) {
      if (session.actor.userId === input.userId && session.status === "active") {
        this.sessionsBySecretHash.set(session.secretHash, { ...session, status: "revoked" });
      }
    }

    const actor = Object.freeze({
      userId: input.userId,
      organizationId: input.organizationId,
      role: input.role,
      sessionId: input.sessionId,
      capturedSessionVersion: user.sessionVersion,
      reauthenticatedAtMs: input.nowMs,
    });
    const absoluteExpiresAtMs = input.nowMs + SESSION_POLICY.absoluteTimeoutMs;
    this.sessionsBySecretHash.set(input.secretHash, {
      actor,
      secretHash: input.secretHash,
      sessionSlot: 1,
      status: "active",
      currentSessionVersion: user.sessionVersion,
      lastSeenAtMs: input.nowMs,
      idleExpiresAtMs: Math.min(input.nowMs + SESSION_POLICY.idleTimeoutMs, absoluteExpiresAtMs),
      absoluteExpiresAtMs,
    });
    return actor;
  }

  async createInvite(input: InvitePersistenceInput): Promise<void> {
    const idempotencyScope = `${input.organizationId}:${input.idempotencyKey}`;
    if (this.inviteByIdempotency.has(idempotencyScope)) {
      throw new IdentityRepositoryError("INVITE_ALREADY_EXISTS");
    }
    for (const invite of this.invites.values()) {
      if (
        invite.organizationId === input.organizationId &&
        invite.targetUserId === input.targetUserId &&
        invite.status === "created"
      ) {
        throw new IdentityRepositoryError("INVITE_ALREADY_EXISTS");
      }
    }
    if (this.usersById.has(input.targetUserId)) {
      throw new IdentityRepositoryError("INVITE_ALREADY_EXISTS");
    }
    this.invites.set(input.inviteId, {
      ...input,
      status: "created",
      providerSubject: null,
      deliveryReceipt: null,
    });
    this.inviteByIdempotency.set(idempotencyScope, input.inviteId);
    this.usersById.set(input.targetUserId, {
      organizationId: input.organizationId,
      role: input.requestedRole,
      providerSubject: null,
      status: "invited",
      recordVersion: 1,
      sessionVersion: 1,
    });
  }

  async bindProviderIdentity(input: {
    readonly inviteId: string;
    readonly providerSubject: string;
  }): Promise<void> {
    const invite = this.getInvite(input.inviteId);
    if (invite.providerSubject !== null && invite.providerSubject !== input.providerSubject) {
      throw new IdentityRepositoryError("INVITE_IDENTITY_MISMATCH");
    }
    invite.providerSubject = input.providerSubject;
    const user = this.getUser(invite.targetUserId);
    if (user.providerSubject !== null && user.providerSubject !== input.providerSubject) {
      throw new IdentityRepositoryError("INVITE_IDENTITY_MISMATCH");
    }
    user.providerSubject = input.providerSubject;
  }

  async recordInviteDelivery(input: {
    readonly inviteId: string;
    readonly receipt: InviteDeliveryReceipt;
  }): Promise<void> {
    const invite = this.getInvite(input.inviteId);
    if (invite.status !== "created") {
      throw new IdentityRepositoryError("INVITE_NOT_REDEEMABLE");
    }
    invite.deliveryReceipt = input.receipt;
  }

  async claimInvite(input: {
    readonly inviteId: string;
    readonly organizationId: string;
    readonly targetUserId: string;
    readonly secretHash: string;
    readonly nowMs: number;
  }): Promise<ClaimedInviteActivation> {
    const invite = this.getInvite(input.inviteId);
    if (
      invite.organizationId !== input.organizationId ||
      invite.targetUserId !== input.targetUserId ||
      invite.secretHash !== input.secretHash
    ) {
      throw new IdentityRepositoryError("INVITE_NOT_FOUND");
    }
    const decision = evaluateInviteActivation({
      nowMs: input.nowMs,
      status: invite.status,
      expiresAtMs: invite.expiresAtMs,
    });
    if (!decision.allowed) {
      if (decision.code === "INVITE_EXPIRED") invite.status = "expired";
      throw new IdentityRepositoryError(
        decision.code === "INVITE_EXPIRED" ? "INVITE_EXPIRED" : "INVITE_NOT_REDEEMABLE",
      );
    }
    if (invite.providerSubject === null || invite.deliveryReceipt === null) {
      throw new IdentityRepositoryError("INVITE_NOT_REDEEMABLE");
    }
    invite.status = "redeemed";
    return Object.freeze({
      inviteId: invite.inviteId,
      organizationId: invite.organizationId,
      targetUserId: invite.targetUserId,
      providerSubject: invite.providerSubject,
      expiresAtMs: invite.expiresAtMs,
    });
  }

  async createSessionForRedeemedInvite(input: {
    readonly activation: ClaimedInviteActivation;
    readonly providerSubject: string;
    readonly sessionId: string;
    readonly secretHash: string;
    readonly nowMs: number;
  }): Promise<IdentitySessionActor> {
    const invite = this.getInvite(input.activation.inviteId);
    const user = this.getUser(input.activation.targetUserId);
    if (
      invite.status !== "redeemed" ||
      invite.organizationId !== input.activation.organizationId ||
      invite.targetUserId !== input.activation.targetUserId ||
      invite.providerSubject !== input.providerSubject ||
      input.activation.providerSubject !== input.providerSubject
    ) {
      throw new IdentityRepositoryError("INVITE_IDENTITY_MISMATCH");
    }
    if (
      user.organizationId !== invite.organizationId ||
      user.providerSubject !== input.providerSubject ||
      user.status === "disabled"
    ) {
      throw new IdentityRepositoryError("INVITE_IDENTITY_MISMATCH");
    }

    const activeSessions = [...this.sessionsBySecretHash.values()].filter(
      (session) =>
        session.actor.userId === invite.targetUserId &&
        session.status === "active" &&
        session.absoluteExpiresAtMs > input.nowMs,
    );
    const slotDecision = selectAvailableSessionSlot(
      activeSessions.map((session) => session.sessionSlot),
    );
    if (!slotDecision.allowed) {
      throw new IdentityRepositoryError("SESSION_LIMIT_REACHED");
    }

    const actor = Object.freeze({
      userId: invite.targetUserId,
      organizationId: invite.organizationId,
      role: user.role,
      sessionId: input.sessionId,
      capturedSessionVersion: user.sessionVersion,
      reauthenticatedAtMs: input.nowMs,
    });
    user.status = "active";
    const absoluteExpiresAtMs = input.nowMs + SESSION_POLICY.absoluteTimeoutMs;
    const session: StoredSession = {
      actor,
      secretHash: input.secretHash,
      sessionSlot: slotDecision.slot,
      status: "active",
      currentSessionVersion: user.sessionVersion,
      lastSeenAtMs: input.nowMs,
      idleExpiresAtMs: Math.min(input.nowMs + SESSION_POLICY.idleTimeoutMs, absoluteExpiresAtMs),
      absoluteExpiresAtMs,
    };
    this.sessionsBySecretHash.set(input.secretHash, session);
    return actor;
  }

  async findActorBySessionSecretHash(input: {
    readonly secretHash: string;
    readonly nowMs: number;
    readonly sensitiveAction: boolean;
  }): Promise<IdentitySessionActor> {
    const session = this.sessionsBySecretHash.get(input.secretHash);
    if (!session) throw new IdentityRepositoryError("SESSION_NOT_FOUND");
    const user = this.getUser(session.actor.userId);
    const decision = evaluateSession({
      nowMs: input.nowMs,
      sensitiveAction: input.sensitiveAction,
      userStatus: user.status,
      currentSessionVersion: user.sessionVersion,
      sessionStatus: session.status,
      capturedSessionVersion: session.actor.capturedSessionVersion,
      organizationStatus: "active",
      membershipStatus: "active",
      idleExpiresAtMs: session.idleExpiresAtMs,
      absoluteExpiresAtMs: session.absoluteExpiresAtMs,
      reauthenticatedAtMs: session.actor.reauthenticatedAtMs,
    });
    if (!decision.allowed) {
      session.status = decision.code.endsWith("EXPIRED") ? "expired" : "revoked";
      throw new IdentityRepositoryError("SESSION_NOT_FOUND");
    }
    session.lastSeenAtMs = input.nowMs;
    session.idleExpiresAtMs = Math.min(
      input.nowMs + SESSION_POLICY.idleTimeoutMs,
      session.absoluteExpiresAtMs,
    );
    return session.actor;
  }

  async revokeSessionBySecretHash(input: {
    readonly secretHash: string;
    readonly reason: string;
  }): Promise<void> {
    const session = this.sessionsBySecretHash.get(input.secretHash);
    if (session) session.status = "revoked";
  }

  async disableUser(input: {
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
  }): Promise<DisableUserResult> {
    const idempotencyScope = [
      input.organizationId,
      input.actorUserId,
      "identity.user.disable",
      input.idempotencyKey,
    ].join(":");
    const existingWorkId = this.revokeWorkByIdempotency.get(idempotencyScope);
    if (existingWorkId !== undefined) {
      const existing = this.getRevokeWork(existingWorkId);
      if (existing.requestHash !== input.requestHash) {
        throw new IdentityRevokeError("REVOKE_IDEMPOTENCY_KEY_REUSED");
      }
      const user = this.getUser(existing.userId);
      return Object.freeze({
        userId: existing.userId,
        organizationId: existing.organizationId,
        recordVersion: user.recordVersion,
        sessionVersion: user.sessionVersion,
        revokeWorkId: existing.id,
        status: "pending",
      });
    }

    const user = this.usersById.get(input.targetUserId);
    if (!user) throw new IdentityRevokeError("REVOKE_USER_NOT_FOUND");
    if (user.organizationId !== input.organizationId) {
      throw new IdentityRevokeError("REVOKE_USER_ORGANIZATION_MISMATCH");
    }
    if (user.recordVersion !== input.expectedRecordVersion) {
      throw new IdentityRevokeError("REVOKE_STALE_VERSION");
    }
    if (user.status === "disabled") throw new IdentityRevokeError("REVOKE_USER_ALREADY_DISABLED");
    if (user.status !== "active") throw new IdentityRevokeError("REVOKE_USER_NOT_ACTIVE");
    if (user.providerSubject === null) {
      throw new IdentityRevokeError("REVOKE_PROVIDER_IDENTITY_MISSING");
    }

    // One in-memory critical section models the production RDS transaction.
    user.status = "disabled";
    user.recordVersion += 1;
    user.sessionVersion += 1;
    for (const session of this.sessionsBySecretHash.values()) {
      if (session.actor.userId === input.targetUserId && session.status === "active") {
        session.status = "revoked";
      }
    }
    const work: StoredCognitoRevokeWork = {
      id: input.effects.outbox.id,
      organizationId: input.organizationId,
      userId: input.targetUserId,
      providerSubject: user.providerSubject,
      requestHash: input.requestHash,
      idempotencyScope,
      status: "pending",
      attemptCount: 0,
      availableAtMs: input.disabledAtMs,
      leasedUntilMs: null,
      leaseVersion: 1,
      receipt: null,
    };
    this.revokeWorkById.set(work.id, work);
    this.revokeWorkByIdempotency.set(idempotencyScope, work.id);
    this.effectsByRevokeWorkId.set(work.id, input.effects);
    return Object.freeze({
      userId: input.targetUserId,
      organizationId: input.organizationId,
      recordVersion: user.recordVersion,
      sessionVersion: user.sessionVersion,
      revokeWorkId: work.id,
      status: "pending",
    });
  }

  async findCognitoRevokeStatus(input: {
    readonly revokeWorkId: string;
  }): Promise<CognitoRevokeStatus> {
    const work = this.getRevokeWork(input.revokeWorkId);
    return Object.freeze({
      revokeWorkId: work.id,
      status: work.status,
      attemptCount: work.attemptCount,
      receipt: work.receipt === null ? null : Object.freeze({ ...work.receipt }),
    });
  }

  async claimDueCognitoRevoke(input: {
    readonly nowMs: number;
    readonly leaseDurationMs: number;
  }): Promise<CognitoRevokeLease | null> {
    for (const work of this.revokeWorkById.values()) {
      if (work.status === "processing" && work.leasedUntilMs !== null && work.leasedUntilMs <= input.nowMs) {
        work.status = "pending";
        work.leasedUntilMs = null;
      }
    }
    const work = [...this.revokeWorkById.values()].find(
      (candidate) => candidate.status === "pending" && candidate.availableAtMs <= input.nowMs,
    );
    if (!work) return null;
    work.status = "processing";
    work.leasedUntilMs = input.nowMs + input.leaseDurationMs;
    work.leaseVersion += 1;
    return Object.freeze({
      revokeWorkId: work.id,
      leaseVersion: work.leaseVersion,
      providerSubject: work.providerSubject,
      attemptCount: work.attemptCount,
    });
  }

  async recordCognitoRevokeDelivered(input: {
    readonly revokeWorkId: string;
    readonly leaseVersion: number;
    readonly completedAtMs: number;
  }): Promise<void> {
    const work = this.requireCurrentLease(input.revokeWorkId, input.leaseVersion);
    work.attemptCount += 1;
    work.status = "delivered";
    work.leasedUntilMs = null;
    work.receipt = Object.freeze({
      outcome: "delivered",
      attemptCount: work.attemptCount,
      failureCode: null,
    });
  }

  async recordCognitoRevokeRetry(input: {
    readonly revokeWorkId: string;
    readonly leaseVersion: number;
    readonly attemptedAtMs: number;
    readonly nextAvailableAtMs: number;
    readonly errorCode: string;
  }): Promise<void> {
    const work = this.requireCurrentLease(input.revokeWorkId, input.leaseVersion);
    work.attemptCount += 1;
    if (work.attemptCount >= COGNITO_REVOKE_MAX_ATTEMPTS) {
      throw new IdentityRevokeError("REVOKE_LEASE_CONFLICT");
    }
    work.status = "pending";
    work.availableAtMs = input.nextAvailableAtMs;
    work.leasedUntilMs = null;
  }

  async recordCognitoRevokeDeadLetter(input: {
    readonly revokeWorkId: string;
    readonly leaseVersion: number;
    readonly completedAtMs: number;
    readonly errorCode: string;
  }): Promise<void> {
    const work = this.requireCurrentLease(input.revokeWorkId, input.leaseVersion);
    work.attemptCount += 1;
    if (work.attemptCount > COGNITO_REVOKE_MAX_ATTEMPTS) {
      throw new IdentityRevokeError("REVOKE_LEASE_CONFLICT");
    }
    work.status = "dead_letter";
    work.leasedUntilMs = null;
    work.receipt = Object.freeze({
      outcome: "failed",
      attemptCount: work.attemptCount,
      failureCode: input.errorCode,
    });
  }

  private getInvite(inviteId: string): StoredInvite {
    const invite = this.invites.get(inviteId);
    if (!invite) throw new IdentityRepositoryError("INVITE_NOT_FOUND");
    return invite;
  }

  private getUser(userId: string): StoredIdentityUser {
    const user = this.usersById.get(userId);
    if (!user) throw new IdentityRepositoryError("INVITE_NOT_FOUND");
    return user;
  }

  private getRevokeWork(revokeWorkId: string): StoredCognitoRevokeWork {
    const work = this.revokeWorkById.get(revokeWorkId);
    if (!work) throw new IdentityRevokeError("REVOKE_STATUS_NOT_FOUND");
    return work;
  }

  private requireCurrentLease(revokeWorkId: string, leaseVersion: number): StoredCognitoRevokeWork {
    const work = this.getRevokeWork(revokeWorkId);
    if (work.status !== "processing" || work.leaseVersion !== leaseVersion) {
      throw new IdentityRevokeError("REVOKE_LEASE_CONFLICT");
    }
    return work;
  }
}
