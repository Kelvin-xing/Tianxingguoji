import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import {
  DATABASE_TEST_PASSWORD_POLICY,
  DatabaseTestAuthenticationError,
  DatabaseTestLoginService,
  deriveDatabaseTestVerifier,
  type DatabaseTestCredentialSnapshot,
  type DatabaseTestLoginRepository,
} from "../../../modules/identity/application/database-test-login.ts";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000002";
const SESSION_ID = "10000000-0000-4000-8000-000000000003";
const COOKIE_SECRET = randomBytes(32).toString("base64url");

test("freezes the approved scrypt-v1 registry and lockout policy", () => {
  assert.deepEqual(DATABASE_TEST_PASSWORD_POLICY, {
    version: "scrypt-v1",
    N: 32768,
    r: 8,
    p: 1,
    keyLength: 64,
    saltBytes: 32,
    maxmem: 67108864,
    passwordMaxBytes: 256,
    emailMaxBytes: 254,
    failureWindowMs: 900000,
    failureLimit: 5,
    lockDurationMs: 900000,
  });
  assert.equal(Object.isFrozen(DATABASE_TEST_PASSWORD_POLICY), true);
});

test("normalizes a synthetic email and passes an exact credential version CAS", async () => {
  const salt = Buffer.alloc(32, 7);
  const verifier = await deriveDatabaseTestVerifier(Buffer.from("correct password"), salt);
  const repository = new FakeDatabaseTestLoginRepository({
    userId: USER_ID,
    verifierVersion: "scrypt-v1",
    salt,
    verifier,
    credentialVersion: 9,
  });
  const service = new DatabaseTestLoginService(repository, {
    nowMs: () => 1_800_000_000_000,
    createId: () => SESSION_ID,
    createSecret: () => COOKIE_SECRET,
  });

  const session = await service.createSession({
    email: " Synthetic.User@Example.Invalid ",
    password: "correct password",
  });

  assert.equal(repository.lookups[0], "synthetic.user@example.invalid");
  assert.equal(repository.completions[0]?.userId, USER_ID);
  assert.equal(repository.completions[0]?.expectedCredentialVersion, 9);
  assert.equal(repository.completions[0]?.passwordMatched, true);
  assert.equal(repository.completions[0]?.sessionId, SESSION_ID);
  assert.match(repository.completions[0]?.secretHash ?? "", /^[a-f0-9]{64}$/);
  assert.equal(repository.completions[0]?.nowMs, 1_800_000_000_000);
  assert.equal(session.cookieSecret, COOKIE_SECRET);
  assert.equal(session.actor.userId, USER_ID);
});

test("uses the same public denial for wrong, unknown, malformed, and oversized credentials", async () => {
  const salt = Buffer.alloc(32, 9);
  const verifier = await deriveDatabaseTestVerifier(Buffer.from("correct password"), salt);
  const cases = [
    { email: "known@example.invalid", password: "wrong", credential: credential(salt, verifier) },
    { email: "unknown@example.invalid", password: "wrong", credential: null },
    { email: "not-an-email", password: "wrong", credential: null },
    { email: "known@example.invalid", password: "x".repeat(257), credential: credential(salt, verifier) },
  ];
  for (const candidate of cases) {
    const repository = new FakeDatabaseTestLoginRepository(candidate.credential, false);
    const service = new DatabaseTestLoginService(repository, {
      createId: () => SESSION_ID,
      createSecret: () => COOKIE_SECRET,
    });
    await assert.rejects(
      service.createSession(candidate),
      DatabaseTestAuthenticationError,
    );
    assert.equal(repository.completions.length, 1);
    assert.equal(repository.completions[0]?.passwordMatched, false);
  }
});

function credential(salt: Buffer, verifier: Buffer): DatabaseTestCredentialSnapshot {
  return { userId: USER_ID, verifierVersion: "scrypt-v1", salt, verifier, credentialVersion: 9 };
}

class FakeDatabaseTestLoginRepository implements DatabaseTestLoginRepository {
  readonly lookups: string[] = [];
  readonly completions: Array<Parameters<DatabaseTestLoginRepository["completeLoginAttempt"]>[0]> = [];
  private readonly credential: DatabaseTestCredentialSnapshot | null;
  private readonly allowMatched: boolean;

  constructor(credential: DatabaseTestCredentialSnapshot | null, allowMatched = true) {
    this.credential = credential;
    this.allowMatched = allowMatched;
  }

  async findCredential(normalizedEmail: string): Promise<DatabaseTestCredentialSnapshot | null> {
    this.lookups.push(normalizedEmail);
    return this.credential;
  }

  async completeLoginAttempt(
    input: Parameters<DatabaseTestLoginRepository["completeLoginAttempt"]>[0],
  ) {
    this.completions.push(input);
    if (!input.passwordMatched || !this.allowMatched) return null;
    return {
      userId: USER_ID,
      organizationId: ORGANIZATION_ID,
      role: "founder" as const,
      sessionId: SESSION_ID,
      capturedSessionVersion: 3,
      reauthenticatedAtMs: input.nowMs,
    };
  }
}
