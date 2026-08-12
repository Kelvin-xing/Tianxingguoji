import { randomBytes, randomUUID } from "node:crypto";

import type { OrganizationRole } from "../access/contract.ts";
import { CognitoAdapterError, CognitoInviteAdapter, type CognitoManagedIdentity } from "./cognito-adapter.ts";
import { INVITE_POLICY } from "./contract.ts";
import {
  hashOpaqueSecret,
  IdentityRepositoryError,
  type ClaimedInviteActivation,
  type IdentitySessionActor,
  type IdentitySessionRepository,
  type InviteDeliveryReceipt,
} from "./session-repository.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ACTIVATION_CREDENTIAL = /^v1\.([0-9a-f-]{36})\.([0-9a-f-]{36})\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/i;
const RECEIPT_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ORGANIZATION_ROLES = new Set<OrganizationRole>([
  "founder",
  "admin",
  "advisor",
  "data_reviewer",
  "contractor",
]);

export interface IdentityClock {
  nowMs(): number;
}

export interface FounderInviteActor {
  readonly userId: string;
  readonly organizationId: string;
  readonly role: OrganizationRole;
}

export interface InviteTarget {
  readonly userId: string;
  readonly normalizedEmail: string;
  readonly role: OrganizationRole;
}

export interface InviteDeliveryChannel {
  deliver(input: {
    readonly inviteId: string;
    readonly organizationId: string;
    readonly targetUserId: string;
    readonly normalizedEmail: string;
    readonly cognitoUsername: string;
    readonly activationCredential: string;
    readonly expiresAtMs: number;
  }): Promise<InviteDeliveryReceipt>;
}

export interface IdentityServiceOptions {
  readonly repository: IdentitySessionRepository;
  readonly cognito: CognitoInviteAdapter;
  readonly deliveryChannel: InviteDeliveryChannel;
  readonly clock?: IdentityClock;
  readonly createSecret?: () => string;
  readonly createSessionSecret?: () => string;
  readonly createId?: () => string;
}

export type IdentityServiceErrorCode =
  | "FOUNDER_REQUIRED"
  | "INVITE_INVALID"
  | "INVITE_ALREADY_EXISTS"
  | "INVITE_NOT_FOUND"
  | "INVITE_NOT_REDEEMABLE"
  | "INVITE_EXPIRED"
  | "IDENTITY_MISMATCH"
  | "TOTP_REQUIRED"
  | "SESSION_LIMIT_REACHED"
  | "SESSION_NOT_FOUND"
  | "COGNITO_PROVISION_FAILED"
  | "INVITE_DELIVERY_FAILED";

export class IdentityServiceError extends Error {
  readonly code: IdentityServiceErrorCode;

  constructor(code: IdentityServiceErrorCode) {
    super(`Identity service rejected ${code}.`);
    this.name = "IdentityServiceError";
    this.code = code;
  }
}

export interface CreatedFounderInvite {
  readonly inviteId: string;
  readonly targetUserId: string;
  readonly expiresAtMs: number;
  readonly deliveryReceipt: InviteDeliveryReceipt;
}

export interface CreatedOpaqueSession {
  readonly cookieSecret: string;
  readonly actor: IdentitySessionActor;
}

export class IdentityService {
  private readonly repository: IdentitySessionRepository;
  private readonly cognito: CognitoInviteAdapter;
  private readonly deliveryChannel: InviteDeliveryChannel;
  private readonly clock: IdentityClock;
  private readonly createSecret: () => string;
  private readonly createSessionSecret: () => string;
  private readonly createId: () => string;

  constructor(options: IdentityServiceOptions) {
    this.repository = options.repository;
    this.cognito = options.cognito;
    this.deliveryChannel = options.deliveryChannel;
    this.clock = options.clock ?? { nowMs: () => Date.now() };
    this.createSecret = options.createSecret ?? createOpaqueSecret;
    this.createSessionSecret = options.createSessionSecret ?? createOpaqueSecret;
    this.createId = options.createId ?? randomUUID;
  }

  async createFounderInvite(input: {
    readonly actor: FounderInviteActor;
    readonly target: InviteTarget;
    readonly idempotencyKey: string;
  }): Promise<CreatedFounderInvite> {
    assertFounder(input.actor);
    assertInviteTarget(input.target);
    if (!IDEMPOTENCY_KEY.test(input.idempotencyKey)) {
      throw new IdentityServiceError("INVITE_INVALID");
    }
    const nowMs = this.clock.nowMs();
    const inviteId = this.createId();
    const activationSecret = this.createSecret();
    assertOpaqueSecret(activationSecret);
    const expiresAtMs = nowMs + INVITE_POLICY.expiresInMs;
    const activationCredential = buildActivationCredential({
      organizationId: input.actor.organizationId,
      inviteId,
      targetUserId: input.target.userId,
      activationSecret,
    });

    try {
      await this.repository.createInvite({
        inviteId,
        organizationId: input.actor.organizationId,
        targetUserId: input.target.userId,
        invitedByUserId: input.actor.userId,
        normalizedEmail: input.target.normalizedEmail,
        requestedRole: input.target.role,
        secretHash: hashOpaqueSecret(activationSecret),
        expiresAtMs,
        idempotencyKey: input.idempotencyKey,
        createdAtMs: nowMs,
      });
    } catch (error) {
      throw mapRepositoryError(error);
    }

    let providerSubject: string;
    try {
      ({ providerSubject } = await this.cognito.provisionInvite({
        userId: input.target.userId,
        organizationId: input.actor.organizationId,
        normalizedEmail: input.target.normalizedEmail,
        activationSecret,
      }));
      await this.repository.bindProviderIdentity({ inviteId, providerSubject });
    } catch (error) {
      if (error instanceof IdentityRepositoryError) throw mapRepositoryError(error);
      if (error instanceof CognitoAdapterError) throw new IdentityServiceError("COGNITO_PROVISION_FAILED");
      throw new IdentityServiceError("COGNITO_PROVISION_FAILED");
    }

    let deliveryReceipt: InviteDeliveryReceipt;
    try {
      deliveryReceipt = await this.deliveryChannel.deliver({
        inviteId,
        organizationId: input.actor.organizationId,
        targetUserId: input.target.userId,
        normalizedEmail: input.target.normalizedEmail,
        cognitoUsername: input.target.userId,
        activationCredential,
        expiresAtMs,
      });
      assertDeliveryReceipt(deliveryReceipt);
      await this.repository.recordInviteDelivery({ inviteId, receipt: deliveryReceipt });
    } catch {
      throw new IdentityServiceError("INVITE_DELIVERY_FAILED");
    }

    return Object.freeze({
      inviteId,
      targetUserId: input.target.userId,
      expiresAtMs,
      deliveryReceipt,
    });
  }

  async claimInviteActivation(input: {
    readonly activationCredential: string;
  }): Promise<ClaimedInviteActivation> {
    const parsed = parseActivationCredential(input.activationCredential);
    try {
      return await this.repository.claimInvite({
        inviteId: parsed.inviteId,
        organizationId: parsed.organizationId,
        targetUserId: parsed.targetUserId,
        secretHash: hashOpaqueSecret(parsed.activationSecret),
        nowMs: this.clock.nowMs(),
      });
    } catch (error) {
      throw mapRepositoryError(error);
    }
  }

  async completeManagedLogin(input: {
    readonly activation: ClaimedInviteActivation;
    readonly identity: CognitoManagedIdentity;
  }): Promise<CreatedOpaqueSession> {
    if (!input.identity.totpVerified) throw new IdentityServiceError("TOTP_REQUIRED");
    if (
      input.activation.organizationId !== input.identity.organizationId ||
      input.activation.targetUserId !== input.identity.userId ||
      input.activation.providerSubject !== input.identity.providerSubject
    ) {
      throw new IdentityServiceError("IDENTITY_MISMATCH");
    }
    const cookieSecret = this.createSessionSecret();
    assertOpaqueSecret(cookieSecret);
    try {
      const actor = await this.repository.createSessionForRedeemedInvite({
        activation: input.activation,
        providerSubject: input.identity.providerSubject,
        sessionId: this.createId(),
        secretHash: hashOpaqueSecret(cookieSecret),
        nowMs: this.clock.nowMs(),
      });
      return Object.freeze({ cookieSecret, actor });
    } catch (error) {
      throw mapRepositoryError(error);
    }
  }

  async requireSession(input: {
    readonly cookieSecret: string;
    readonly sensitiveAction: boolean;
  }): Promise<IdentitySessionActor> {
    try {
      return await this.repository.findActorBySessionSecretHash({
        secretHash: hashOpaqueSecret(input.cookieSecret),
        nowMs: this.clock.nowMs(),
        sensitiveAction: input.sensitiveAction,
      });
    } catch (error) {
      throw mapRepositoryError(error);
    }
  }

  async revokeSession(input: {
    readonly cookieSecret: string;
    readonly reason: string;
  }): Promise<void> {
    await this.repository.revokeSessionBySecretHash({
      secretHash: hashOpaqueSecret(input.cookieSecret),
      reason: input.reason,
    });
  }
}

function mapRepositoryError(error: unknown): IdentityServiceError {
  if (!(error instanceof IdentityRepositoryError)) {
    return new IdentityServiceError("INVITE_INVALID");
  }
  const map: Readonly<Record<IdentityRepositoryError["code"], IdentityServiceErrorCode>> = {
    INVITE_ALREADY_EXISTS: "INVITE_ALREADY_EXISTS",
    INVITE_NOT_FOUND: "INVITE_NOT_FOUND",
    INVITE_NOT_REDEEMABLE: "INVITE_NOT_REDEEMABLE",
    INVITE_EXPIRED: "INVITE_EXPIRED",
    INVITE_IDENTITY_MISMATCH: "IDENTITY_MISMATCH",
    SESSION_LIMIT_REACHED: "SESSION_LIMIT_REACHED",
    SESSION_NOT_FOUND: "SESSION_NOT_FOUND",
  };
  return new IdentityServiceError(map[error.code]);
}

function buildActivationCredential(input: {
  readonly organizationId: string;
  readonly inviteId: string;
  readonly targetUserId: string;
  readonly activationSecret: string;
}): string {
  return [
    INVITE_POLICY.activationCredentialVersion,
    input.organizationId,
    input.inviteId,
    input.targetUserId,
    input.activationSecret,
  ].join(".");
}

function parseActivationCredential(value: string): {
  readonly organizationId: string;
  readonly inviteId: string;
  readonly targetUserId: string;
  readonly activationSecret: string;
} {
  const match = ACTIVATION_CREDENTIAL.exec(value);
  if (!match) throw new IdentityServiceError("INVITE_INVALID");
  return Object.freeze({
    organizationId: match[1]!.toLowerCase(),
    inviteId: match[2]!.toLowerCase(),
    targetUserId: match[3]!.toLowerCase(),
    activationSecret: match[4]!,
  });
}

function assertFounder(actor: FounderInviteActor): void {
  if (actor.role !== "founder" || !UUID.test(actor.userId) || !UUID.test(actor.organizationId)) {
    throw new IdentityServiceError("FOUNDER_REQUIRED");
  }
}

function assertInviteTarget(target: InviteTarget): void {
  if (
    !UUID.test(target.userId) ||
    !ORGANIZATION_ROLES.has(target.role) ||
    target.normalizedEmail.length === 0 ||
    target.normalizedEmail.length > 320 ||
    target.normalizedEmail !== target.normalizedEmail.trim().toLowerCase()
  ) {
    throw new IdentityServiceError("INVITE_INVALID");
  }
}

function assertOpaqueSecret(secret: string): void {
  if (Buffer.from(secret, "base64url").length !== INVITE_POLICY.activationSecretBytes) {
    throw new IdentityServiceError("INVITE_INVALID");
  }
}

function assertDeliveryReceipt(receipt: InviteDeliveryReceipt): void {
  if (
    receipt.channelPolicyId !== INVITE_POLICY.deliveryChannelPolicyId ||
    !RECEIPT_REFERENCE.test(receipt.receiptReference) ||
    !Number.isSafeInteger(receipt.deliveredAtMs) ||
    receipt.deliveredAtMs <= 0
  ) {
    throw new IdentityServiceError("INVITE_DELIVERY_FAILED");
  }
}

function createOpaqueSecret(): string {
  return randomBytes(INVITE_POLICY.activationSecretBytes).toString("base64url");
}
