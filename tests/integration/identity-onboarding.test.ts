import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CognitoInviteAdapter,
  type CognitoAdminClient,
  type CognitoAdminCreateUserRequest,
} from "../../modules/identity/infrastructure/cognito-adapter.ts";
import {
  decodePendingInviteActivation,
  encodePendingInviteActivation,
} from "../../modules/identity/infrastructure/activation-cookie.ts";
import {
  IdentityService,
  IdentityServiceError,
  type InviteDeliveryChannel,
} from "../../modules/identity/application/service.ts";
import { InMemoryIdentitySessionRepository } from "../../modules/identity/infrastructure/in-memory-session-repository.ts";

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
  private currentMs: number;

  constructor(currentMs: number) {
    this.currentMs = currentMs;
  }

  nowMs(): number {
    return this.currentMs;
  }

  advance(milliseconds: number): void {
    this.currentMs += milliseconds;
  }
}

class RecordingCognitoClient implements CognitoAdminClient {
  readonly calls: CognitoAdminCreateUserRequest[] = [];

  async adminCreateUser(request: CognitoAdminCreateUserRequest) {
    this.calls.push(request);
    return { providerSubject: "cognito-subject-001" };
  }
}

class RecordingDeliveryChannel implements InviteDeliveryChannel {
  readonly deliveries: Array<{ readonly activationCredential: string }> = [];

  async deliver(input: {
    readonly inviteId: string;
    readonly organizationId: string;
    readonly targetUserId: string;
    readonly normalizedEmail: string;
    readonly cognitoUsername: string;
    readonly activationCredential: string;
    readonly expiresAtMs: number;
  }) {
    this.deliveries.push({ activationCredential: input.activationCredential });
    return {
      channelPolicyId: "hk_dpa_reviewed_transactional",
      receiptReference: "delivery-receipt-001",
      deliveredAtMs: 1_754_265_600_000,
    } as const;
  }
}

function createService(clock = new FixedClock(1_754_265_600_000)) {
  const repository = new InMemoryIdentitySessionRepository();
  const cognitoClient = new RecordingCognitoClient();
  const deliveryChannel = new RecordingDeliveryChannel();
  const service = new IdentityService({
    repository,
    cognito: new CognitoInviteAdapter({
      userPoolId: "ap-east-1_example",
      client: cognitoClient,
    }),
    deliveryChannel,
    clock,
    createSecret: () => Buffer.alloc(32, 7).toString("base64url"),
    createSessionSecret: () => Buffer.alloc(32, 9).toString("base64url"),
    createId: (() => {
      let sequence = 4;
      return () => `00000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`;
    })(),
  });

  return { service, repository, cognitoClient, deliveryChannel, clock };
}

test("Founder issues a one-display 24-hour invite through Cognito SUPPRESS and records delivery proof", async () => {
  const { service, cognitoClient, deliveryChannel } = createService();

  const invite = await service.createFounderInvite({
    actor: FOUNDER,
    target: ADVISOR,
    idempotencyKey: "invite-advisor-001",
  });

  assert.deepEqual(invite, {
    inviteId: "00000000-0000-4000-8000-000000000004",
    targetUserId: ADVISOR.userId,
    expiresAtMs: 1_754_524_800_000,
    deliveryReceipt: {
      channelPolicyId: "hk_dpa_reviewed_transactional",
      receiptReference: "delivery-receipt-001",
      deliveredAtMs: 1_754_265_600_000,
    },
  });
  assert.deepEqual(cognitoClient.calls, [
    {
      userPoolId: "ap-east-1_example",
      username: ADVISOR.userId,
      temporaryPassword: Buffer.alloc(32, 7).toString("base64url"),
      messageAction: "SUPPRESS",
      userAttributes: {
        email: ADVISOR.normalizedEmail,
        "custom:organization_id": FOUNDER.organizationId,
        "custom:internal_user_id": ADVISOR.userId,
      },
    },
  ]);
  assert.equal(deliveryChannel.deliveries.length, 1);
  assert.match(deliveryChannel.deliveries[0]!.activationCredential, /^v1\./);
  assert.doesNotMatch(JSON.stringify(invite), /Bw{4,}|advisor@example\.hk/);
});

test("an invite can be claimed once and only a TOTP-complete Cognito identity receives an opaque session", async () => {
  const { service, deliveryChannel } = createService();

  await service.createFounderInvite({
    actor: FOUNDER,
    target: ADVISOR,
    idempotencyKey: "invite-advisor-002",
  });
  const activationCredential = deliveryChannel.deliveries[0]!.activationCredential;

  const activation = await service.claimInviteActivation({ activationCredential });
  await assert.rejects(
    service.claimInviteActivation({ activationCredential }),
    identityError("INVITE_NOT_REDEEMABLE"),
  );

  const session = await service.completeManagedLogin({
    activation,
    identity: {
      providerSubject: "cognito-subject-001",
      organizationId: FOUNDER.organizationId,
      userId: ADVISOR.userId,
      totpVerified: true,
    },
  });

  assert.deepEqual(session.actor, {
    userId: ADVISOR.userId,
    organizationId: FOUNDER.organizationId,
    role: "advisor",
    sessionId: "00000000-0000-4000-8000-000000000005",
    capturedSessionVersion: 1,
    reauthenticatedAtMs: 1_754_265_600_000,
  });
  assert.equal(session.cookieSecret, Buffer.alloc(32, 9).toString("base64url"));
  assert.doesNotMatch(session.cookieSecret, /advisor|example|22222222/);
});

test("expired invites and identities that did not complete TOTP fail closed", async () => {
  const { service, deliveryChannel, clock } = createService();

  await service.createFounderInvite({
    actor: FOUNDER,
    target: ADVISOR,
    idempotencyKey: "invite-advisor-003",
  });
  const firstCredential = deliveryChannel.deliveries[0]!.activationCredential;
  const activation = await service.claimInviteActivation({ activationCredential: firstCredential });

  await assert.rejects(
    service.completeManagedLogin({
      activation,
      identity: {
        providerSubject: "cognito-subject-001",
        organizationId: FOUNDER.organizationId,
        userId: ADVISOR.userId,
        totpVerified: false,
      },
    }),
    identityError("TOTP_REQUIRED"),
  );

  const second = await createSecondInvite(service, deliveryChannel);
  clock.advance(72 * 60 * 60 * 1_000);
  await assert.rejects(
    service.claimInviteActivation({ activationCredential: second }),
    identityError("INVITE_EXPIRED"),
  );
});

test("the callback activation cookie is signed, short-lived, and contains no invite secret", () => {
  const signingKey = Buffer.alloc(32, 1).toString("base64");
  const activation = {
    inviteId: "00000000-0000-4000-8000-000000000004",
    organizationId: FOUNDER.organizationId,
    targetUserId: ADVISOR.userId,
    providerSubject: "cognito-subject-001",
    expiresAtMs: 1_754_265_700_000,
  } as const;
  const encoded = encodePendingInviteActivation(activation, signingKey);

  assert.deepEqual(
    decodePendingInviteActivation(encoded, signingKey, 1_754_265_600_000),
    activation,
  );
  assert.equal(
    decodePendingInviteActivation(encoded, signingKey, activation.expiresAtMs),
    undefined,
  );
  assert.equal(
    decodePendingInviteActivation(`${encoded}x`, signingKey, 1_754_265_600_000),
    undefined,
  );
  assert.doesNotMatch(encoded, /Bw{4,}|advisor@example\.hk/);
});

test("delivery receipt persistence is tenant-scoped and has no activation-secret column", () => {
  const migration = readFileSync(
    new URL(
      "../../db/migrations/202608030040_009_expand_identity_invite_delivery_receipts.sql",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(migration, /CREATE TABLE identity_invite_delivery_receipts/);
  assert.match(migration, /organization_id uuid NOT NULL REFERENCES access_organizations/);
  assert.match(migration, /channel_policy_id = 'hk_dpa_reviewed_transactional'/);
  assert.match(migration, /ALTER TABLE identity_invite_delivery_receipts ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /current_setting\('app\.organization_id', true\)/);
  assert.doesNotMatch(migration, /activation_secret|raw_secret|secret_value/i);
});

async function createSecondInvite(
  service: IdentityService,
  deliveryChannel: RecordingDeliveryChannel,
): Promise<string> {
  const target = {
    userId: "44444444-4444-4444-8444-444444444444",
    normalizedEmail: "second-advisor@example.hk",
    role: "advisor" as const,
  };
  await service.createFounderInvite({
    actor: FOUNDER,
    target,
    idempotencyKey: "invite-advisor-004",
  });

  return deliveryChannel.deliveries.at(-1)!.activationCredential;
}

function identityError(code: string): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof IdentityServiceError);
    assert.equal(error.code, code);
    return true;
  };
}
