import { randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";

import type { IdentitySessionActor } from "../domain/actor.ts";
import { hashOpaqueSecret } from "./opaque-secret.ts";

export const DATABASE_TEST_PASSWORD_POLICY = Object.freeze({
  version: "scrypt-v1" as const,
  N: 32_768,
  r: 8,
  p: 1,
  keyLength: 64,
  saltBytes: 32,
  maxmem: 64 * 1024 * 1024,
  passwordMaxBytes: 256,
  emailMaxBytes: 254,
  failureWindowMs: 15 * 60 * 1_000,
  failureLimit: 5,
  lockDurationMs: 15 * 60 * 1_000,
});

const SYNTHETIC_EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.invalid$/;
const DUMMY_SALT = Buffer.from("a1".repeat(DATABASE_TEST_PASSWORD_POLICY.saltBytes), "hex");
const DUMMY_VERIFIER = Buffer.from("b2".repeat(DATABASE_TEST_PASSWORD_POLICY.keyLength), "hex");
const DUMMY_PASSWORD = Buffer.from("invalid-database-test-password", "utf8");

export interface DatabaseTestCredentialSnapshot {
  readonly userId: string;
  readonly verifierVersion: typeof DATABASE_TEST_PASSWORD_POLICY.version;
  readonly salt: Uint8Array;
  readonly verifier: Uint8Array;
  readonly credentialVersion: number;
}

export interface DatabaseTestLoginRepository {
  findCredential(normalizedEmail: string): Promise<DatabaseTestCredentialSnapshot | null>;
  completeLoginAttempt(input: Readonly<{
    userId: string | null;
    expectedCredentialVersion: number | null;
    passwordMatched: boolean;
    sessionId: string;
    secretHash: string;
    nowMs: number;
  }>): Promise<IdentitySessionActor | null>;
}

export interface DatabaseTestCreatedSession {
  readonly cookieSecret: string;
  readonly actor: IdentitySessionActor;
}

export class DatabaseTestAuthenticationError extends Error {
  constructor() {
    super("Database test authentication failed.");
    this.name = "DatabaseTestAuthenticationError";
  }
}

export class DatabaseTestLoginService {
  private readonly repository: DatabaseTestLoginRepository;
  private readonly nowMs: () => number;
  private readonly createId: () => string;
  private readonly createSecret: () => string;

  constructor(
    repository: DatabaseTestLoginRepository,
    dependencies: Readonly<{
      nowMs?: () => number;
      createId?: () => string;
      createSecret?: () => string;
    }> = {},
  ) {
    this.repository = repository;
    this.nowMs = dependencies.nowMs ?? Date.now;
    this.createId = dependencies.createId ?? randomUUID;
    this.createSecret = dependencies.createSecret ?? (() => randomBytes(32).toString("base64url"));
  }

  async createSession(input: Readonly<{ email: unknown; password: unknown }>): Promise<DatabaseTestCreatedSession> {
    const normalizedEmail = normalizeSyntheticEmail(input.email);
    const password = passwordBytes(input.password);
    let derived: Buffer | undefined;
    try {
      const credential = await this.repository.findCredential(
        normalizedEmail ?? "INVALID-AUTHENTICATION-SUBJECT",
      );
      const salt = credential?.salt ?? DUMMY_SALT;
      const expected = credential?.verifier ?? DUMMY_VERIFIER;
      derived = await deriveScrypt(password ?? DUMMY_PASSWORD, salt);
      const matched = password !== null && credential !== null && safeEqual(derived, expected);
      const cookieSecret = this.createSecret();
      const actor = await this.repository.completeLoginAttempt({
        userId: credential?.userId ?? null,
        expectedCredentialVersion: credential?.credentialVersion ?? null,
        passwordMatched: matched,
        sessionId: this.createId(),
        secretHash: hashOpaqueSecret(cookieSecret),
        nowMs: this.nowMs(),
      });
      if (actor === null) throw new DatabaseTestAuthenticationError();
      return Object.freeze({ cookieSecret, actor });
    } finally {
      password?.fill(0);
      derived?.fill(0);
    }
  }
}

export function normalizeSyntheticEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (
    Buffer.byteLength(normalized, "utf8") > DATABASE_TEST_PASSWORD_POLICY.emailMaxBytes ||
    !SYNTHETIC_EMAIL.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

export function deriveDatabaseTestVerifier(password: Uint8Array, salt: Uint8Array): Promise<Buffer> {
  if (salt.byteLength !== DATABASE_TEST_PASSWORD_POLICY.saltBytes) {
    throw new TypeError("Database test credential salt is invalid.");
  }
  if (password.byteLength < 1 || password.byteLength > DATABASE_TEST_PASSWORD_POLICY.passwordMaxBytes) {
    throw new TypeError("Database test credential password is invalid.");
  }
  return deriveScrypt(password, salt);
}

function passwordBytes(value: unknown): Buffer | null {
  if (typeof value !== "string") return null;
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength < 1 || bytes.byteLength > DATABASE_TEST_PASSWORD_POLICY.passwordMaxBytes) {
    bytes.fill(0);
    return null;
  }
  return bytes;
}

function deriveScrypt(password: Uint8Array, salt: Uint8Array): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      DATABASE_TEST_PASSWORD_POLICY.keyLength,
      {
        N: DATABASE_TEST_PASSWORD_POLICY.N,
        r: DATABASE_TEST_PASSWORD_POLICY.r,
        p: DATABASE_TEST_PASSWORD_POLICY.p,
        maxmem: DATABASE_TEST_PASSWORD_POLICY.maxmem,
      },
      (error, derivedKey) => error ? reject(error) : resolve(derivedKey),
    );
  });
}

function safeEqual(actual: Uint8Array, expected: Uint8Array): boolean {
  const left = Buffer.from(actual.buffer, actual.byteOffset, actual.byteLength);
  const right = Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength);
  return left.byteLength === DATABASE_TEST_PASSWORD_POLICY.keyLength &&
    right.byteLength === DATABASE_TEST_PASSWORD_POLICY.keyLength &&
    timingSafeEqual(left, right);
}
