import type { MutationEffectBundle } from "../../modules/audit/contract.ts";
import {
  PortalRepositoryError,
  type PortalAccessGrant,
  type PortalRepository,
  type PortalSessionRecord,
} from "../../modules/external-portal/repository.ts";

interface SeedViewer {
  readonly id: string;
  readonly organizationId: string;
  readonly serviceCaseId: string;
  readonly status: "active" | "inactive";
}

interface StoredGrant extends PortalAccessGrant {
  readonly keyedSecretHash: string;
  readonly secretFingerprint: string;
}

interface StoredSession extends PortalSessionRecord {
  readonly keyedSessionHash: string;
  readonly sessionSlot: 1 | 2 | 3;
}

interface IdempotencyReceipt {
  readonly requestHash: string;
  readonly grantId: string;
}

export class InMemoryPortalRepository implements PortalRepository {
  private readonly viewers = new Map<string, SeedViewer>();
  private readonly grants = new Map<string, StoredGrant>();
  private readonly sessions = new Map<string, StoredSession>();
  private readonly idempotency = new Map<string, IdempotencyReceipt>();
  private readonly sessionIdempotency = new Map<string, { requestHash: string; sessionId: string }>();
  private readonly evidence: MutationEffectBundle[] = [];
  private transactionTail: Promise<void> = Promise.resolve();

  seedViewer(viewer: SeedViewer): void {
    this.viewers.set(viewer.id, Object.freeze({ ...viewer }));
  }

  async issueGrant(input: Parameters<PortalRepository["issueGrant"]>[0]): Promise<PortalAccessGrant> {
    return this.transaction(async () => {
      const replay = this.replay(input, "issue");
      if (replay) return replay;
      this.assertViewer(input.portalViewerId, input.organizationId, input.serviceCaseId);
      this.assertSecretUnique(input.keyedSecretHash, input.secretFingerprint);
      if (this.activeGrantCount(input.lifecycleId) !== 0) {
        throw new PortalRepositoryError("PORTAL_GRANT_NOT_ACTIVE");
      }
      const grant: StoredGrant = {
        id: input.grantId,
        lifecycleId: input.lifecycleId,
        organizationId: input.organizationId,
        serviceCaseId: input.serviceCaseId,
        portalViewerId: input.portalViewerId,
        capabilitySetVersion: input.capabilitySetVersion,
        status: "active",
        issuedByUserId: input.issuedByUserId,
        issuedAtMs: input.issuedAtMs,
        expiresAtMs: input.expiresAtMs,
        revokedByUserId: null,
        revokedAtMs: null,
        revokeReasonCode: null,
        recordVersion: 1,
        keyedSecretHash: input.keyedSecretHash,
        secretFingerprint: input.secretFingerprint,
      };
      this.grants.set(grant.id, grant);
      this.complete(input, "issue", grant.id);
      return this.publicGrant(grant);
    });
  }

  async revokeGrant(input: Parameters<PortalRepository["revokeGrant"]>[0]): Promise<PortalAccessGrant> {
    return this.transaction(async () => {
      const replay = this.replay(input, "revoke");
      if (replay) return replay;
      const grant = this.requireGrant(input.organizationId, input.serviceCaseId, input.grantId);
      this.assertVersion(grant, input.expectedRecordVersion);
      if (grant.status !== "active") throw new PortalRepositoryError("PORTAL_GRANT_NOT_ACTIVE");
      this.revoke(grant, input.actorUserId, input.revokedAtMs, input.reasonCode);
      this.complete(input, "revoke", grant.id);
      return this.publicGrant(grant);
    });
  }

  async rotateGrant(input: Parameters<PortalRepository["rotateGrant"]>[0]): Promise<PortalAccessGrant> {
    return this.transaction(async () => {
      const replay = this.replay(input, "rotate");
      if (replay) return replay;
      const oldGrant = this.requireGrant(input.organizationId, input.serviceCaseId, input.oldGrantId);
      this.assertVersion(oldGrant, input.expectedRecordVersion);
      this.assertViewer(input.portalViewerId, input.organizationId, input.serviceCaseId);
      this.assertSecretUnique(input.keyedSecretHash, input.secretFingerprint);
      if (oldGrant.status !== "active" || oldGrant.lifecycleId !== input.lifecycleId) {
        throw new PortalRepositoryError("PORTAL_GRANT_NOT_ACTIVE");
      }
      this.revoke(oldGrant, input.actorUserId, input.rotatedAtMs, "rotated");
      const replacement: StoredGrant = {
        id: input.newGrantId,
        lifecycleId: input.lifecycleId,
        organizationId: input.organizationId,
        serviceCaseId: input.serviceCaseId,
        portalViewerId: input.portalViewerId,
        capabilitySetVersion: input.capabilitySetVersion,
        status: "active",
        issuedByUserId: input.actorUserId,
        issuedAtMs: input.rotatedAtMs,
        expiresAtMs: input.expiresAtMs,
        revokedByUserId: null,
        revokedAtMs: null,
        revokeReasonCode: null,
        recordVersion: 1,
        keyedSecretHash: input.keyedSecretHash,
        secretFingerprint: input.secretFingerprint,
      };
      this.grants.set(replacement.id, replacement);
      this.complete(input, "rotate", replacement.id);
      return this.publicGrant(replacement);
    });
  }

  async createSession(input: Parameters<PortalRepository["createSession"]>[0]): Promise<PortalSessionRecord> {
    return this.transaction(async () => {
      const scope = `${input.organizationId}:redeem:${input.idempotencyKey}`;
      const receipt = this.sessionIdempotency.get(scope);
      if (receipt) {
        if (receipt.requestHash !== input.requestHash) {
          throw new PortalRepositoryError("PORTAL_IDEMPOTENCY_KEY_REUSED");
        }
        return this.publicSession(this.sessions.get(receipt.sessionId)!);
      }
      const grant = this.requireGrant(input.organizationId, input.serviceCaseId, input.grantId);
      if (grant.status !== "active" || input.createdAtMs >= grant.expiresAtMs) {
        throw new PortalRepositoryError("PORTAL_GRANT_NOT_ACTIVE");
      }
      const active = [...this.sessions.values()].filter((session) =>
        session.grantId === grant.id && session.status === "active" &&
        session.idleExpiresAtMs > input.createdAtMs && session.absoluteExpiresAtMs > input.createdAtMs
      );
      if (active.length >= 3) throw new PortalRepositoryError("PORTAL_SESSION_LIMIT_REACHED");
      const used = new Set(active.map((session) => session.sessionSlot));
      const slot = [1, 2, 3].find((candidate) => !used.has(candidate)) as 1 | 2 | 3;
      const session: StoredSession = {
        id: input.sessionId,
        organizationId: input.organizationId,
        serviceCaseId: input.serviceCaseId,
        grantId: input.grantId,
        status: "active",
        createdAtMs: input.createdAtMs,
        lastSeenAtMs: input.createdAtMs,
        idleExpiresAtMs: input.idleExpiresAtMs,
        absoluteExpiresAtMs: input.absoluteExpiresAtMs,
        recordVersion: 1,
        keyedSessionHash: input.keyedSessionHash,
        sessionSlot: slot,
      };
      this.sessions.set(session.id, session);
      this.sessionIdempotency.set(scope, { requestHash: input.requestHash, sessionId: session.id });
      this.evidence.push(input.effects);
      return this.publicSession(session);
    });
  }

  async findGrant(organizationId: string, serviceCaseId: string, grantId: string): Promise<PortalAccessGrant | null> {
    const grant = this.grants.get(grantId);
    return grant?.organizationId === organizationId && grant.serviceCaseId === serviceCaseId
      ? this.publicGrant(grant)
      : null;
  }

  activeSessionCount(grantId: string, nowMs: number): number {
    return [...this.sessions.values()].filter((session) => session.grantId === grantId &&
      session.status === "active" && session.idleExpiresAtMs > nowMs && session.absoluteExpiresAtMs > nowMs).length;
  }

  activeGrantCount(lifecycleId: string): number {
    return [...this.grants.values()].filter((grant) => grant.lifecycleId === lifecycleId && grant.status === "active").length;
  }

  securityEvidence(): readonly MutationEffectBundle[] {
    return Object.freeze([...this.evidence]);
  }

  private async transaction<T>(operation: () => Promise<T>): Promise<T> {
    const predecessor = this.transactionTail;
    let release!: () => void;
    this.transactionTail = new Promise<void>((resolve) => { release = resolve; });
    await predecessor;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private replay(
    input: { organizationId: string; actorUserId?: string; issuedByUserId?: string; idempotencyKey: string; requestHash: string },
    operation: string,
  ): PortalAccessGrant | null {
    const actor = input.actorUserId ?? input.issuedByUserId!;
    const receipt = this.idempotency.get(`${input.organizationId}:${actor}:${operation}:${input.idempotencyKey}`);
    if (!receipt) return null;
    if (receipt.requestHash !== input.requestHash) {
      throw new PortalRepositoryError("PORTAL_IDEMPOTENCY_KEY_REUSED");
    }
    return this.publicGrant(this.grants.get(receipt.grantId)!);
  }

  private complete(
    input: { organizationId: string; actorUserId?: string; issuedByUserId?: string; idempotencyKey: string; requestHash: string; effects: MutationEffectBundle },
    operation: string,
    grantId: string,
  ): void {
    const actor = input.actorUserId ?? input.issuedByUserId!;
    this.idempotency.set(`${input.organizationId}:${actor}:${operation}:${input.idempotencyKey}`, {
      requestHash: input.requestHash,
      grantId,
    });
    this.evidence.push(input.effects);
  }

  private assertViewer(viewerId: string, organizationId: string, serviceCaseId: string): void {
    const viewer = this.viewers.get(viewerId);
    if (!viewer || viewer.status !== "active" || viewer.organizationId !== organizationId || viewer.serviceCaseId !== serviceCaseId) {
      throw new PortalRepositoryError("PORTAL_CONTEXT_MISMATCH");
    }
  }

  private assertSecretUnique(keyedHash: string, fingerprint: string): void {
    for (const grant of this.grants.values()) {
      if (grant.keyedSecretHash === keyedHash || grant.secretFingerprint === fingerprint) {
        throw new PortalRepositoryError("PORTAL_SECRET_CONFLICT");
      }
    }
  }

  private requireGrant(organizationId: string, serviceCaseId: string, grantId: string): StoredGrant {
    const grant = this.grants.get(grantId);
    if (!grant) throw new PortalRepositoryError("PORTAL_GRANT_NOT_FOUND");
    if (grant.organizationId !== organizationId || grant.serviceCaseId !== serviceCaseId) {
      throw new PortalRepositoryError("PORTAL_CONTEXT_MISMATCH");
    }
    return grant;
  }

  private assertVersion(grant: StoredGrant, expected: number): void {
    if (grant.recordVersion !== expected) throw new PortalRepositoryError("PORTAL_VERSION_CONFLICT");
  }

  private revoke(grant: StoredGrant, actorUserId: string, atMs: number, reasonCode: string): void {
    Object.assign(grant, {
      status: "revoked",
      revokedByUserId: actorUserId,
      revokedAtMs: atMs,
      revokeReasonCode: reasonCode,
      recordVersion: grant.recordVersion + 1,
    });
    for (const session of this.sessions.values()) {
      if (session.grantId === grant.id && session.status === "active") {
        Object.assign(session, { status: "revoked", recordVersion: session.recordVersion + 1 });
      }
    }
  }

  private publicGrant(grant: StoredGrant): PortalAccessGrant {
    const { keyedSecretHash: _hash, secretFingerprint: _fingerprint, ...safe } = grant;
    return Object.freeze({ ...safe });
  }

  private publicSession(session: StoredSession): PortalSessionRecord {
    const { keyedSessionHash: _hash, sessionSlot: _slot, ...safe } = session;
    return Object.freeze({ ...safe });
  }
}
