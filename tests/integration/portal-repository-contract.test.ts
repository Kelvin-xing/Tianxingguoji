import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import type { MutationEffectBundle } from "../../modules/audit/domain/contract.ts";
import type {
  DatabaseQuery,
  DatabaseQueryResult,
  TenantTransactionContext,
  TenantTransaction,
  TenantTransactionRunner,
} from "../../modules/shared/server.ts";
import {
  PortalRepositoryError,
  type PortalAccessGrant,
  type PortalRepository,
} from "../../modules/external-portal/application/repository-port.ts";
import {
  PortalRuntimeUnavailable,
  getPortalRuntime,
} from "../../modules/external-portal/infrastructure/runtime.ts";
import { PostgreSqlPortalRepository } from "../../modules/external-portal/infrastructure/postgresql-repository.ts";
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
    actorUserId: ids.actor,
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
      actorUserId: ids.actor,
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

test("redeem claim ids are unique per grant idempotency key and replay keeps its session", async () => {
  const state = createRedeemDatabase();
  const repository = new PostgreSqlPortalRepository({
    runner: state.runner,
    secretPepper: state.pepper,
    accessReadPort: {
      async readActorFacts() {
        return { organizationStatus: "active", userStatus: "active", membershipStatus: "active", isFounder: false };
      },
    },
    casesReadPort: {
      async readCaseFacts() {
        return { studentId: ids.viewer, primaryUserId: ids.actor, workflowStatus: "active", stage: "signed", updatedAt: new Date(issuedAtMs).toISOString() };
      },
      async readWorkspaceFacts() {
        return null;
      },
    },
    crmReadPort: {
      async readGuardianRelationship() {
        return { active: true, studentId: ids.viewer };
      },
    },
    schoolsReadPort: {
      async readLabels() {
        return new Map();
      },
    },
  });

  const first = await repository.redeemAccess!(redeemInput("redeem-a", "90000000-0000-4000-8000-000000000001"));
  const second = await repository.redeemAccess!(redeemInput("redeem-b", "90000000-0000-4000-8000-000000000002"));
  const replay = await repository.redeemAccess!(redeemInput("redeem-a", "90000000-0000-4000-8000-000000000003"));

  assert.equal(state.claimIds.length, 2);
  assert.notEqual(state.claimIds[0], state.claimIds[1]);
  assert.equal(replay.id, first.id);
  assert.notEqual(second.id, first.id);
});

const REDEEM_SECRET = "s".repeat(43);
const REDEEM_PEPPER = "p".repeat(32);

function redeemInput(idempotencyKey: string, sessionId: string) {
  return {
    accessKey: `p1.${ids.organization}.${ids.case}.${ids.grant}.${REDEEM_SECRET}`,
    idempotencyKey,
    requestId: `request-${idempotencyKey}`,
    nowMs: issuedAtMs + 1_000,
    sessionId,
    keyedSessionHash: "aa".repeat(32),
    sessionSecret: `p1.${ids.organization}.${ids.case}.${ids.grant}.${"t".repeat(43)}`,
  };
}

function createRedeemDatabase(): Readonly<{ runner: TenantTransactionRunner; claimIds: string[]; pepper: string }> {
  interface Receipt {
    id: string;
    requestHash: string;
    state: "in_progress" | "completed" | "failed";
    resultReference: string | null;
    responseHash: string | null;
    recordVersion: number;
  }
  const receipts = new Map<string, Receipt>();
  const sessions = new Map<string, Record<string, unknown>>();
  const claimIds: string[] = [];
  const grantSecretHash = createHmac("sha256", REDEEM_PEPPER)
    .update(`grant:${ids.grant}:${REDEEM_SECRET}`)
    .digest("hex");
  const grantRow = {
    id: ids.grant,
    lifecycle_id: ids.grant,
    organization_id: ids.organization,
    service_case_id: ids.case,
    portal_viewer_id: ids.viewer,
    capability_set_version: "portal_case_read_v1",
    status: "active",
    issued_by_user_id: ids.actor,
    issued_at: new Date(issuedAtMs).toISOString(),
    expires_at: new Date(issuedAtMs + 7 * 24 * 60 * 60_000).toISOString(),
    revoked_by_user_id: null,
    revoked_at: null,
    revoke_reason_code: null,
    record_version: 1,
    secret_fingerprint: "b".repeat(64),
    keyed_secret_hash: grantSecretHash,
    viewer_status: "active",
    guardian_relationship_id: ids.viewer,
  };

  const runner: TenantTransactionRunner = Object.freeze({
    async run<Result>(_context: TenantTransactionContext, operation: (transaction: TenantTransaction) => Promise<Result>): Promise<Result> {
      const transaction: TenantTransaction = Object.freeze({
        async query<Row = Record<string, unknown>>(query: DatabaseQuery): Promise<DatabaseQueryResult<Row>> {
          const text = query.text;
          const values = query.values ?? [];
          if (text.includes("SELECT pg_try_advisory_xact_lock")) return result<Row>([{ acquired: true }]);
          if (text.includes("SELECT id, organization_id, actor_kind, actor_opaque_id")) {
            const receipt = receipts.get(readReceiptKey(values));
            return result<Row>(receipt ? [receiptRow(receipt, values)] : []);
          }
          if (text.includes("INSERT INTO shared_idempotency_records")) {
            const receipt: Receipt = { id: String(values[0]), requestHash: String(values[7]), state: "in_progress", resultReference: null, responseHash: null, recordVersion: 1 };
            receipts.set(insertReceiptKey(values), receipt);
            claimIds.push(receipt.id);
            return result<Row>([{ id: receipt.id }]);
          }
          if (text.includes("UPDATE shared_idempotency_records")) {
            const key = `${String(values[0])}|${String(values[1])}|${String(values[2])}|${String(values[3])}|${String(values[4])}`;
            const receipt = receipts.get(key);
            assert.ok(receipt);
            receipt.state = String(values[5]) as Receipt["state"];
            receipt.resultReference = String(values[6]);
            receipt.responseHash = String(values[7]);
            receipt.recordVersion = Number(values[8]);
            return result<Row>([{ id: receipt.id }]);
          }
          if (text.includes("FROM portal_access_grants AS g")) return result<Row>([grantRow]);
          if (text.includes("SELECT * FROM portal_access_grants WHERE id=$1") && text.includes("FOR UPDATE")) return result<Row>([grantRow]);
          if (text.includes("SELECT count(*)::int AS count FROM portal_sessions")) return result<Row>([{ count: 0 }]);
          if (text.includes("SELECT slot FROM generate_series")) return result<Row>([{ slot: 1 }]);
          if (text.includes("INSERT INTO portal_sessions")) {
            const row = sessionRow(values);
            sessions.set(row.id as string, row);
            return result<Row>([row]);
          }
          if (text.includes("SELECT * FROM portal_sessions WHERE id=$1")) {
            const row = sessions.get(String(values[0]));
            return result<Row>(row ? [row] : []);
          }
          if (text.includes("INSERT INTO audit_events") || text.includes("INSERT INTO audit_outbox")) return result<Row>([], 1);
          throw new Error(`Unexpected redeem repository query: ${text}`);
        },
      });
      return operation(transaction);
    },
  });
  return Object.freeze({ runner, claimIds, pepper: REDEEM_PEPPER });

  function readReceiptKey(values: readonly unknown[]): string {
    return `${String(values[0])}|${String(values[1])}|${String(values[2])}|${String(values[3])}|${String(values[4])}`;
  }

  function insertReceiptKey(values: readonly unknown[]): string {
    return `${String(values[1])}|${String(values[3])}|${String(values[4])}|${String(values[5])}|${String(values[6])}`;
  }

  function receiptRow(receipt: Receipt, values: readonly unknown[]) {
    return {
      id: receipt.id,
      organization_id: String(values[0]),
      actor_kind: String(values[1]),
      actor_opaque_id: String(values[2]),
      operation: String(values[3]),
      idempotency_key: String(values[4]),
      request_hash: receipt.requestHash,
      state: receipt.state,
      result_reference: receipt.resultReference,
      response_hash: receipt.responseHash,
      record_version: receipt.recordVersion,
      created_at: new Date(issuedAtMs).toISOString(),
      updated_at: new Date(issuedAtMs).toISOString(),
    };
  }

  function sessionRow(values: readonly unknown[]): Record<string, unknown> {
    return {
      id: String(values[0]),
      organization_id: String(values[1]),
      service_case_id: String(values[2]),
      grant_id: String(values[3]),
      session_slot: Number(values[4]),
      keyed_session_hash: String(values[5]),
      status: "active",
      grant_expires_at: grantRow.expires_at,
      last_seen_at: new Date(Number(values[7])).toISOString(),
      idle_expires_at: new Date(Number(values[8])).toISOString(),
      absolute_expires_at: new Date(Number(values[9])).toISOString(),
      record_version: 1,
      created_at: new Date(Number(values[7])).toISOString(),
      updated_at: new Date(Number(values[7])).toISOString(),
    };
  }
}

function result<Row>(rows: readonly unknown[], rowCount?: number): DatabaseQueryResult<Row> {
  return { rows: rows as readonly Row[], rowCount };
}

function repositoryError(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof PortalRepositoryError && error.code === code;
}
