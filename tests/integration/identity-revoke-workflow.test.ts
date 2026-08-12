import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { CognitoInviteAdapter, type CognitoAdminClient } from "../../modules/identity/cognito-adapter.ts";
import {
  COGNITO_REVOKE_RETRY_BACKOFF_MS,
  IdentityRevokeError,
  IdentityRevokeWorkflow,
} from "../../modules/identity/revoke-workflow.ts";
import { IdentityService, IdentityServiceError, type InviteDeliveryChannel } from "../../modules/identity/service.ts";
import { InMemoryIdentitySessionRepository } from "../../modules/identity/session-repository.ts";
import { reconcileCognitoRevokes } from "../../workers/reconcile-cognito.ts";
import { SyntheticCognitoFake } from "../fakes/cognito.ts";

const FOUNDER = Object.freeze({
  userId: "11111111-1111-4111-8111-111111111111",
  organizationId: "22222222-2222-4222-8222-222222222222",
  role: "founder" as const,
});

const ADVISOR = Object.freeze({
  userId: "33333333-3333-4333-8333-333333333333",
  normalizedEmail: "advisor@example.hk",
  role: "advisor" as const,
});

class FixedClock {
  private currentMs = 1_754_265_600_000;

  nowMs(): number {
    return this.currentMs;
  }

  advance(milliseconds: number): void {
    this.currentMs += milliseconds;
  }
}

class RecordingCognitoClient implements CognitoAdminClient {
  async adminCreateUser() {
    return { providerSubject: "cognito-subject-001" };
  }
}

class RecordingDeliveryChannel implements InviteDeliveryChannel {
  readonly credentials: string[] = [];

  async deliver(input: {
    readonly activationCredential: string;
  }) {
    this.credentials.push(input.activationCredential);
    return {
      channelPolicyId: "hk_dpa_reviewed_transactional",
      receiptReference: "delivery-receipt-001",
      deliveredAtMs: 1_754_265_600_000,
    } as const;
  }
}

function createActivatedAdvisor() {
  const clock = new FixedClock();
  const repository = new InMemoryIdentitySessionRepository();
  const deliveryChannel = new RecordingDeliveryChannel();
  const service = new IdentityService({
    repository,
    cognito: new CognitoInviteAdapter({
      userPoolId: "ap-east-1_example",
      client: new RecordingCognitoClient(),
    }),
    deliveryChannel,
    clock,
    createSecret: () => Buffer.alloc(32, 7).toString("base64url"),
    createSessionSecret: () => Buffer.alloc(32, 9).toString("base64url"),
    createId: sequenceIds(4),
  });
  const workflow = new IdentityRevokeWorkflow({
    repository,
    clock,
    createId: sequenceIds(901),
  });

  return { clock, repository, service, deliveryChannel, workflow };
}

test("account disable rejects an already-issued opaque session before a Cognito timeout can reconcile", async () => {
  const { clock, service, deliveryChannel, workflow, repository } = createActivatedAdvisor();
  const session = await issueAdvisorSession(service, deliveryChannel);

  const disabled = await workflow.disableUser({
    organizationId: FOUNDER.organizationId,
    actorUserId: FOUNDER.userId,
    targetUserId: ADVISOR.userId,
    expectedRecordVersion: 1,
    reasonCode: "security_review",
    requestId: "request-p1-04-001",
    idempotencyKey: "disable-advisor-001",
  });

  assert.deepEqual(disabled, {
    userId: ADVISOR.userId,
    organizationId: FOUNDER.organizationId,
    recordVersion: 2,
    sessionVersion: 2,
    revokeWorkId: "00000000-0000-4000-8000-000000000902",
    status: "pending",
  });
  await assert.rejects(
    service.requireSession({ cookieSecret: session.cookieSecret, sensitiveAction: false }),
    identityError("SESSION_NOT_FOUND"),
  );

  const cognito = new SyntheticCognitoFake({ revoke: "timeout" });
  assert.deepEqual(
    await reconcileCognitoRevokes({ repository, cognito, clock, maxJobs: 1 }),
    { claimed: 1, delivered: 0, retried: 1, deadLettered: 0 },
  );
  assert.deepEqual(cognito.calls(), [
    {
      operation: "revoke",
      requestId: "cognito-revoke-00000000-0000-4000-8000-000000000902",
      providerSubject: "cognito-subject-001",
    },
  ]);
  assert.deepEqual(await workflow.getCognitoRevokeStatus({ revokeWorkId: disabled.revokeWorkId }), {
    revokeWorkId: disabled.revokeWorkId,
    status: "pending",
    attemptCount: 1,
    receipt: null,
  });
});

test("three transient Cognito timeouts dead-letter one revoke effect and retain one failed receipt", async () => {
  const { clock, service, deliveryChannel, workflow, repository } = createActivatedAdvisor();
  await issueAdvisorSession(service, deliveryChannel);
  const disabled = await workflow.disableUser({
    organizationId: FOUNDER.organizationId,
    actorUserId: FOUNDER.userId,
    targetUserId: ADVISOR.userId,
    expectedRecordVersion: 1,
    reasonCode: "security_review",
    requestId: "request-p1-04-002",
    idempotencyKey: "disable-advisor-002",
  });
  const cognito = new SyntheticCognitoFake({ revoke: ["timeout", "timeout", "timeout"] });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const expected =
      attempt === 2
        ? { claimed: 1, delivered: 0, retried: 0, deadLettered: 1 }
        : { claimed: 1, delivered: 0, retried: 1, deadLettered: 0 };
    assert.deepEqual(
      await reconcileCognitoRevokes({ repository, cognito, clock, maxJobs: 1 }),
      expected,
    );
    if (attempt < 2) clock.advance(COGNITO_REVOKE_RETRY_BACKOFF_MS[attempt]!);
  }

  assert.equal(cognito.calls().length, 3);
  assert.deepEqual(await workflow.getCognitoRevokeStatus({ revokeWorkId: disabled.revokeWorkId }), {
    revokeWorkId: disabled.revokeWorkId,
    status: "dead_letter",
    attemptCount: 3,
    receipt: {
      outcome: "failed",
      attemptCount: 3,
      failureCode: "COGNITO_TIMEOUT",
    },
  });
});

test("a replayed disable emits no second effect and a later successful retry persists one delivery receipt", async () => {
  const { clock, service, deliveryChannel, workflow, repository } = createActivatedAdvisor();
  await issueAdvisorSession(service, deliveryChannel);
  const command = {
    organizationId: FOUNDER.organizationId,
    actorUserId: FOUNDER.userId,
    targetUserId: ADVISOR.userId,
    expectedRecordVersion: 1,
    reasonCode: "security_review",
    requestId: "request-p1-04-003",
    idempotencyKey: "disable-advisor-003",
  } as const;
  const disabled = await workflow.disableUser(command);
  assert.deepEqual(await workflow.disableUser(command), disabled);

  const cognito = new SyntheticCognitoFake({ revoke: ["timeout", "success"] });
  await reconcileCognitoRevokes({ repository, cognito, clock, maxJobs: 1 });
  clock.advance(COGNITO_REVOKE_RETRY_BACKOFF_MS[0]!);
  assert.deepEqual(
    await reconcileCognitoRevokes({ repository, cognito, clock, maxJobs: 1 }),
    { claimed: 1, delivered: 1, retried: 0, deadLettered: 0 },
  );
  assert.deepEqual(
    await reconcileCognitoRevokes({ repository, cognito, clock, maxJobs: 1 }),
    { claimed: 0, delivered: 0, retried: 0, deadLettered: 0 },
  );
  assert.equal(cognito.calls().length, 2);
  assert.deepEqual(await workflow.getCognitoRevokeStatus({ revokeWorkId: disabled.revokeWorkId }), {
    revokeWorkId: disabled.revokeWorkId,
    status: "delivered",
    attemptCount: 2,
    receipt: {
      outcome: "delivered",
      attemptCount: 2,
      failureCode: null,
    },
  });
});

test("only an active User can enter the irreversible disabled state", async () => {
  const { service, deliveryChannel, workflow } = createActivatedAdvisor();
  await service.createFounderInvite({
    actor: FOUNDER,
    target: ADVISOR,
    idempotencyKey: "invite-advisor-p1-04-invited",
  });
  assert.equal(deliveryChannel.credentials.length, 1);

  await assert.rejects(
    workflow.disableUser({
      organizationId: FOUNDER.organizationId,
      actorUserId: FOUNDER.userId,
      targetUserId: ADVISOR.userId,
      expectedRecordVersion: 1,
      reasonCode: "security_review",
      requestId: "request-p1-04-004",
      idempotencyKey: "disable-advisor-004",
    }),
    revokeError("REVOKE_USER_NOT_ACTIVE"),
  );
});

test("a stale User version is rejected before session access or revoke work changes", async () => {
  const { service, deliveryChannel, workflow } = createActivatedAdvisor();
  const session = await issueAdvisorSession(service, deliveryChannel);

  await assert.rejects(
    workflow.disableUser({
      organizationId: FOUNDER.organizationId,
      actorUserId: FOUNDER.userId,
      targetUserId: ADVISOR.userId,
      expectedRecordVersion: 2,
      reasonCode: "security_review",
      requestId: "request-p1-04-005",
      idempotencyKey: "disable-advisor-005",
    }),
    revokeError("REVOKE_STALE_VERSION"),
  );
  assert.equal(
    (await service.requireSession({ cookieSecret: session.cookieSecret, sensitiveAction: false })).userId,
    ADVISOR.userId,
  );
});

test("the Cognito revoke receipt is tenant-scoped, outbox-linked, and excludes provider identity data", () => {
  const migration = readFileSync(
    new URL(
      "../../db/migrations/202608030050_010_expand_identity_cognito_revoke_receipts.sql",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(migration, /CREATE TABLE identity_cognito_revoke_receipts/);
  assert.match(migration, /outbox_id uuid NOT NULL/);
  assert.match(migration, /REFERENCES audit_outbox \(id, organization_id\)/);
  assert.match(migration, /outcome IN \('delivered', 'failed'\)/);
  assert.match(migration, /attempt_count BETWEEN 1 AND 3/);
  assert.match(migration, /CREATE FUNCTION identity_validate_cognito_revoke_receipt/);
  assert.match(migration, /aggregate_id IS DISTINCT FROM NEW\.user_id/);
  assert.match(migration, /idempotency_key IS DISTINCT FROM NEW\.effect_idempotency_key/);
  assert.match(migration, /attempt_count IS DISTINCT FROM NEW\.attempt_count/);
  assert.match(migration, /ALTER TABLE identity_cognito_revoke_receipts ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /current_setting\('app\.organization_id', true\)/);
  assert.doesNotMatch(migration, /provider_subject|access_token|refresh_token|id_token|email/i);
});

async function issueAdvisorSession(
  service: IdentityService,
  deliveryChannel: RecordingDeliveryChannel,
) {
  await service.createFounderInvite({
    actor: FOUNDER,
    target: ADVISOR,
    idempotencyKey: "invite-advisor-p1-04",
  });
  const activation = await service.claimInviteActivation({
    activationCredential: deliveryChannel.credentials[0]!,
  });
  return service.completeManagedLogin({
    activation,
    identity: {
      providerSubject: "cognito-subject-001",
      organizationId: FOUNDER.organizationId,
      userId: ADVISOR.userId,
      totpVerified: true,
    },
  });
}

function sequenceIds(start: number): () => string {
  let current = start;
  return () => `00000000-0000-4000-8000-${String(current++).padStart(12, "0")}`;
}

function identityError(code: string): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof IdentityServiceError);
    assert.equal(error.code, code);
    return true;
  };
}

function revokeError(code: string): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof IdentityRevokeError);
    assert.equal(error.code, code);
    return true;
  };
}
