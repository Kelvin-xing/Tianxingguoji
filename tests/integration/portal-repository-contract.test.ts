import assert from "node:assert/strict";
import test from "node:test";

import type { MutationEffectBundle } from "../../modules/audit/contract.ts";
import {
  PortalRepositoryError,
  type PortalAccessGrant,
  type PortalRepository,
} from "../../modules/external-portal/repository.ts";
import {
  PortalRuntimeUnavailable,
  getPortalRuntime,
} from "../../modules/external-portal/runtime.ts";
import { InMemoryPortalRepository } from "../fakes/portal-repository.ts";

const ids = Object.freeze({
  organization: "11111111-1111-4111-8111-111111111111",
  case: "22222222-2222-4222-8222-222222222222",
  viewer: "33333333-3333-4333-8333-333333333333",
  actor: "44444444-4444-4444-8444-444444444444",
  grant: "55555555-5555-4555-8555-555555555555",
  rotatedGrant: "66666666-6666-4666-8666-666666666666",
});
const issuedAtMs = Date.UTC(2026, 7, 13, 10, 0, 0);

function effects(resourceId: string, sequence: number): MutationEffectBundle {
  const auditId = `70000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
  return {
    audit: {
      id: auditId,
      organizationId: ids.organization,
      actorUserId: ids.actor,
      actorKind: "user",
      eventType: "portal.grant.changed",
      eventVersion: 1,
      action: "portal.grant.change",
      resourceType: "PortalAccessGrant",
      resourceId,
      outcome: "succeeded",
      requestId: `request-${sequence}`,
      occurredAt: new Date(issuedAtMs).toISOString(),
      beforeHashSha256: null,
      afterHashSha256: "a".repeat(64),
      metadata: Object.freeze({ record_version: 1 }),
    },
    outbox: {
      id: `80000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
      auditEventId: auditId,
      organizationId: ids.organization,
      aggregateType: "PortalAccessGrant",
      aggregateId: resourceId,
      eventType: "portal.grant.changed",
      eventVersion: 1,
      idempotencyKey: `portal-change-${sequence}`,
      requestId: `request-${sequence}`,
      payload: Object.freeze({ aggregate_id: resourceId, request_id: `request-${sequence}` }),
      status: "pending",
      attemptCount: 0,
      availableAt: new Date(issuedAtMs).toISOString(),
      createdAt: new Date(issuedAtMs).toISOString(),
    },
  };
}

function seedRepository(): InMemoryPortalRepository {
  const repository = new InMemoryPortalRepository();
  repository.seedViewer({
    id: ids.viewer,
    organizationId: ids.organization,
    serviceCaseId: ids.case,
    status: "active",
  });
  return repository;
}

async function issue(repository: PortalRepository): Promise<PortalAccessGrant> {
  return repository.issueGrant({
    grantId: ids.grant,
    lifecycleId: ids.grant,
    organizationId: ids.organization,
    serviceCaseId: ids.case,
    portalViewerId: ids.viewer,
    issuedByUserId: ids.actor,
    issuedAtMs,
    expiresAtMs: issuedAtMs + 60_000,
    keyedSecretHash: "11".repeat(32),
    secretFingerprint: "22".repeat(32),
    capabilitySetVersion: "portal_case_read_v1",
    idempotencyKey: "issue-1",
    requestHash: "33".repeat(32),
    effects: effects(ids.grant, 1),
  });
}

test("issue replay is stable while key reuse with a changed request fails closed", async () => {
  const repository = seedRepository();
  const first = await issue(repository);
  assert.deepEqual(await issue(repository), first);
  assert.equal(repository.securityEvidence().length, 1);

  await assert.rejects(
    repository.issueGrant({
      grantId: ids.rotatedGrant,
      lifecycleId: ids.rotatedGrant,
      organizationId: ids.organization,
      serviceCaseId: ids.case,
      portalViewerId: ids.viewer,
      issuedByUserId: ids.actor,
      issuedAtMs,
      expiresAtMs: issuedAtMs + 60_000,
      keyedSecretHash: "44".repeat(32),
      secretFingerprint: "55".repeat(32),
      capabilitySetVersion: "portal_case_read_v1",
      idempotencyKey: "issue-1",
      requestHash: "66".repeat(32),
      effects: effects(ids.rotatedGrant, 2),
    }),
    repositoryError("PORTAL_IDEMPOTENCY_KEY_REUSED"),
  );
});

test("session allocation is transactional and a fourth active session is rejected", async () => {
  const repository = seedRepository();
  await issue(repository);

  await Promise.all([1, 2, 3].map((slot) => repository.createSession({
    sessionId: `90000000-0000-4000-8000-${String(slot).padStart(12, "0")}`,
    organizationId: ids.organization,
    serviceCaseId: ids.case,
    grantId: ids.grant,
    keyedSessionHash: `${slot}`.repeat(64),
    createdAtMs: issuedAtMs + slot,
    idleExpiresAtMs: issuedAtMs + 30_000,
    absoluteExpiresAtMs: issuedAtMs + 45_000,
    idempotencyKey: `redeem-${slot}`,
    requestHash: `${slot + 4}`.repeat(64),
    effects: effects(ids.grant, 10 + slot),
  })));

  await assert.rejects(
    repository.createSession({
      sessionId: "90000000-0000-4000-8000-000000000004",
      organizationId: ids.organization,
      serviceCaseId: ids.case,
      grantId: ids.grant,
      keyedSessionHash: "44".repeat(32),
      createdAtMs: issuedAtMs + 4,
      idleExpiresAtMs: issuedAtMs + 30_000,
      absoluteExpiresAtMs: issuedAtMs + 45_000,
      idempotencyKey: "redeem-4",
      requestHash: "88".repeat(32),
      effects: effects(ids.grant, 14),
    }),
    repositoryError("PORTAL_SESSION_LIMIT_REACHED"),
  );
});

test("revoke checks expected version and atomically invalidates all grant sessions", async () => {
  const repository = seedRepository();
  await issue(repository);
  await repository.createSession({
    sessionId: "90000000-0000-4000-8000-000000000001",
    organizationId: ids.organization,
    serviceCaseId: ids.case,
    grantId: ids.grant,
    keyedSessionHash: "77".repeat(32),
    createdAtMs: issuedAtMs + 1,
    idleExpiresAtMs: issuedAtMs + 30_000,
    absoluteExpiresAtMs: issuedAtMs + 45_000,
    idempotencyKey: "redeem-revoke",
    requestHash: "66".repeat(32),
    effects: effects(ids.grant, 15),
  });

  await assert.rejects(repository.revokeGrant({
    organizationId: ids.organization,
    serviceCaseId: ids.case,
    grantId: ids.grant,
    actorUserId: ids.actor,
    expectedRecordVersion: 2,
    revokedAtMs: issuedAtMs + 10,
    reasonCode: "manual_revoke",
    idempotencyKey: "revoke-stale",
    requestHash: "88".repeat(32),
    effects: effects(ids.grant, 3),
  }), repositoryError("PORTAL_VERSION_CONFLICT"));

  const revoked = await repository.revokeGrant({
    organizationId: ids.organization,
    serviceCaseId: ids.case,
    grantId: ids.grant,
    actorUserId: ids.actor,
    expectedRecordVersion: 1,
    revokedAtMs: issuedAtMs + 10,
    reasonCode: "manual_revoke",
    idempotencyKey: "revoke-1",
    requestHash: "99".repeat(32),
    effects: effects(ids.grant, 4),
  });
  assert.equal(revoked.status, "revoked");
  assert.equal(revoked.recordVersion, 2);
  assert.equal(repository.activeSessionCount(ids.grant, issuedAtMs + 11), 0);
  assert.equal(repository.securityEvidence().length, 3);
});

test("rotation revokes the old secret and sessions before exposing one replacement", async () => {
  const repository = seedRepository();
  await issue(repository);
  const replacement = await repository.rotateGrant({
    oldGrantId: ids.grant,
    newGrantId: ids.rotatedGrant,
    lifecycleId: ids.grant,
    organizationId: ids.organization,
    serviceCaseId: ids.case,
    portalViewerId: ids.viewer,
    actorUserId: ids.actor,
    expectedRecordVersion: 1,
    rotatedAtMs: issuedAtMs + 20,
    expiresAtMs: issuedAtMs + 120_000,
    keyedSecretHash: "aa".repeat(32),
    secretFingerprint: "bb".repeat(32),
    capabilitySetVersion: "portal_case_read_v1",
    idempotencyKey: "rotate-1",
    requestHash: "cc".repeat(32),
    effects: effects(ids.rotatedGrant, 5),
  });

  assert.equal(replacement.status, "active");
  assert.equal(replacement.lifecycleId, ids.grant);
  assert.equal(repository.activeGrantCount(ids.grant), 1);
  assert.equal((await repository.findGrant(ids.organization, ids.case, ids.grant))?.status, "revoked");
});

test("production runtime has no implicit repository fallback", () => {
  assert.throws(
    () => getPortalRuntime(),
    (error: unknown) => error instanceof PortalRuntimeUnavailable && error.code === "PORTAL_RUNTIME_UNAVAILABLE",
  );
});

function repositoryError(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof PortalRepositoryError && error.code === code;
}
