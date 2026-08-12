import type { MutationEffectBundle } from "../audit/contract.ts";
import type {
  PortalCapabilitySetVersion,
  PortalGrantStatus,
  PortalSessionStatus,
} from "./contract.ts";

export interface PortalAccessGrant {
  readonly id: string;
  readonly lifecycleId: string;
  readonly organizationId: string;
  readonly serviceCaseId: string;
  readonly portalViewerId: string;
  readonly capabilitySetVersion: PortalCapabilitySetVersion;
  readonly status: PortalGrantStatus;
  readonly issuedByUserId: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly revokedByUserId: string | null;
  readonly revokedAtMs: number | null;
  readonly revokeReasonCode: string | null;
  readonly recordVersion: number;
}

export interface PortalSessionRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly serviceCaseId: string;
  readonly grantId: string;
  readonly status: PortalSessionStatus;
  readonly createdAtMs: number;
  readonly lastSeenAtMs: number;
  readonly idleExpiresAtMs: number;
  readonly absoluteExpiresAtMs: number;
  readonly recordVersion: number;
}

export type PortalRepositoryErrorCode =
  | "PORTAL_CONTEXT_MISMATCH"
  | "PORTAL_GRANT_NOT_FOUND"
  | "PORTAL_GRANT_NOT_ACTIVE"
  | "PORTAL_SECRET_CONFLICT"
  | "PORTAL_SESSION_LIMIT_REACHED"
  | "PORTAL_VERSION_CONFLICT"
  | "PORTAL_IDEMPOTENCY_KEY_REUSED";

export class PortalRepositoryError extends Error {
  readonly code: PortalRepositoryErrorCode;

  constructor(code: PortalRepositoryErrorCode) {
    super(`External portal repository rejected ${code}.`);
    this.name = "PortalRepositoryError";
    this.code = code;
  }
}

export interface PortalGrantMutationContext {
  readonly organizationId: string;
  readonly serviceCaseId: string;
  readonly actorUserId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly effects: MutationEffectBundle;
}

export interface PortalGrantSecretInput {
  /** Hex-encoded 32-byte keyed digest. Raw bearer credentials are never accepted. */
  readonly keyedSecretHash: string;
  /** Hex-encoded, globally unique non-secret operational fingerprint. */
  readonly secretFingerprint: string;
}

export interface PortalRepository {
  /**
   * In one tenant transaction: lock case/viewer/issuer authorization facts,
   * claim idempotency, insert the grant, audit, outbox, and security evidence.
   */
  issueGrant(input: PortalGrantMutationContext & PortalGrantSecretInput & {
    readonly grantId: string;
    readonly lifecycleId: string;
    readonly portalViewerId: string;
    readonly issuedByUserId: string;
    readonly issuedAtMs: number;
    readonly expiresAtMs: number;
    readonly capabilitySetVersion: PortalCapabilitySetVersion;
  }): Promise<PortalAccessGrant>;

  /** Optimistic revoke and all derived-session invalidation are atomic. */
  revokeGrant(input: PortalGrantMutationContext & {
    readonly grantId: string;
    readonly expectedRecordVersion: number;
    readonly revokedAtMs: number;
    readonly reasonCode: string;
  }): Promise<PortalAccessGrant>;

  /** Old revoke, session invalidation, replacement insert, audit and outbox share one transaction. */
  rotateGrant(input: PortalGrantMutationContext & PortalGrantSecretInput & {
    readonly oldGrantId: string;
    readonly newGrantId: string;
    readonly lifecycleId: string;
    readonly portalViewerId: string;
    readonly expectedRecordVersion: number;
    readonly rotatedAtMs: number;
    readonly expiresAtMs: number;
    readonly capabilitySetVersion: PortalCapabilitySetVersion;
  }): Promise<PortalAccessGrant>;

  /**
   * Locks the grant lifecycle, counts active unexpired sessions, allocates one
   * of three slots, and inserts the keyed session digest in one transaction.
   */
  createSession(input: {
    readonly sessionId: string;
    readonly organizationId: string;
    readonly serviceCaseId: string;
    readonly grantId: string;
    readonly keyedSessionHash: string;
    readonly createdAtMs: number;
    readonly idleExpiresAtMs: number;
    readonly absoluteExpiresAtMs: number;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly effects: MutationEffectBundle;
  }): Promise<PortalSessionRecord>;

  /** Full request-time authorization is performed in this tenant transaction. */
  findGrant(
    organizationId: string,
    serviceCaseId: string,
    grantId: string,
  ): Promise<PortalAccessGrant | null>;
}
