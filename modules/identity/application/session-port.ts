import type { OrganizationRole } from "../../access/public.ts";
import type { IdentitySessionActor } from "../domain/actor.ts";
import type { SessionStatus } from "../domain/contract.ts";
import type { IdentityRevokeRepository } from "./revoke-workflow.ts";

export interface InvitePersistenceInput {
  readonly inviteId: string;
  readonly organizationId: string;
  readonly targetUserId: string;
  readonly invitedByUserId: string;
  readonly normalizedEmail: string;
  /** Legacy read compatibility only; new Identity invites leave it empty. */
  readonly requestedRole?: OrganizationRole;
  readonly secretHash: string;
  readonly expiresAtMs: number;
  readonly idempotencyKey: string;
  readonly createdAtMs: number;
}

export interface InviteDeliveryReceipt {
  readonly channelPolicyId: "hk_dpa_reviewed_transactional";
  readonly receiptReference: string;
  readonly deliveredAtMs: number;
}

export interface ClaimedInviteActivation {
  readonly inviteId: string;
  readonly organizationId: string;
  readonly targetUserId: string;
  readonly providerSubject: string;
  readonly expiresAtMs: number;
}

export interface StoredIdentitySession {
  readonly actor: IdentitySessionActor;
  readonly status: SessionStatus;
  readonly currentSessionVersion: number;
  readonly lastSeenAtMs: number;
  readonly idleExpiresAtMs: number;
  readonly absoluteExpiresAtMs: number;
}

export type IdentityRepositoryErrorCode =
  | "INVITE_ALREADY_EXISTS"
  | "INVITE_NOT_FOUND"
  | "INVITE_NOT_REDEEMABLE"
  | "INVITE_EXPIRED"
  | "INVITE_IDENTITY_MISMATCH"
  | "SESSION_LIMIT_REACHED"
  | "SESSION_NOT_FOUND";

export class IdentityRepositoryError extends Error {
  readonly code: IdentityRepositoryErrorCode;

  constructor(code: IdentityRepositoryErrorCode) {
    super(`Identity repository rejected ${code}.`);
    this.name = "IdentityRepositoryError";
    this.code = code;
  }
}

export interface IdentitySessionRepository extends IdentityRevokeRepository {
  createInvite(input: InvitePersistenceInput): Promise<void>;
  bindProviderIdentity(input: {
    readonly inviteId: string;
    readonly providerSubject: string;
  }): Promise<void>;
  recordInviteDelivery(input: {
    readonly inviteId: string;
    readonly receipt: InviteDeliveryReceipt;
  }): Promise<void>;
  claimInvite(input: {
    readonly inviteId: string;
    readonly organizationId: string;
    readonly targetUserId: string;
    readonly secretHash: string;
    readonly nowMs: number;
  }): Promise<ClaimedInviteActivation>;
  createSessionForRedeemedInvite(input: {
    readonly activation: ClaimedInviteActivation;
    readonly providerSubject: string;
    readonly sessionId: string;
    readonly secretHash: string;
    readonly nowMs: number;
  }): Promise<IdentitySessionActor>;
  findActorBySessionSecretHash(input: {
    readonly secretHash: string;
    readonly nowMs: number;
    readonly sensitiveAction: boolean;
  }): Promise<IdentitySessionActor>;
  revokeSessionBySecretHash(input: {
    readonly secretHash: string;
    readonly reason: string;
  }): Promise<void>;
}

export interface LocalSyntheticSessionRepository {
  createLocalSyntheticSession(input: {
    readonly userId: string;
    readonly organizationId: string;
    readonly role: OrganizationRole;
    readonly sessionId: string;
    readonly secretHash: string;
    readonly nowMs: number;
  }): Promise<IdentitySessionActor>;
}
