import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  AuthModeConfigurationError,
  loadAuthMode,
} from "../../../modules/identity/infrastructure/auth-mode.ts";
import { LocalSyntheticLoginService } from "../../../modules/identity/infrastructure/local-synthetic-login.ts";
import { InMemoryIdentitySessionRepository } from "../../../modules/identity/infrastructure/in-memory-session-repository.ts";

test("selects database-test locally and blocks unsupported environment combinations", () => {
  assert.equal(loadAuthMode(localEnvironment()), "database-test");
  assert.equal(loadAuthMode({
    APP_ENV: "production",
    APP_RUNTIME_MODE: "production-aws",
    AUTH_MODE: "cognito",
    NODE_ENV: "production",
  }), "cognito");
  assert.equal(loadAuthMode({
    APP_ENV: "test",
    APP_RUNTIME_MODE: "test-database",
    AUTH_MODE: "database-test",
    NODE_ENV: "production",
    VERCEL: "1",
    VERCEL_ENV: "preview",
  }), "database-test");
  assert.throws(
    () => loadAuthMode({ ...localEnvironment(), AUTH_MODE: undefined }),
    (error: unknown) => error instanceof AuthModeConfigurationError && error.variable === "AUTH_MODE",
  );
  assert.throws(
    () => loadAuthMode({ ...localEnvironment(), NODE_ENV: "production" }),
    (error: unknown) => error instanceof AuthModeConfigurationError && error.variable === "NODE_ENV",
  );
});

test("creates, validates, replaces, and revokes a local opaque session", async () => {
  const repository = new InMemoryIdentitySessionRepository();
  const login = new LocalSyntheticLoginService(repository);
  const first = await login.createSession("founder");

  assert.equal(first.actor.role, "founder");
  assert.equal(Buffer.from(first.cookieSecret, "base64url").length, 32);
  assert.equal(
    (await repository.findActorBySessionSecretHash({
      secretHash: hashForTest(first.cookieSecret),
      nowMs: Date.now(),
      sensitiveAction: true,
    })).userId,
    first.actor.userId,
  );

  const replacement = await login.createSession("founder");
  await assert.rejects(repository.findActorBySessionSecretHash({
    secretHash: hashForTest(first.cookieSecret),
    nowMs: Date.now(),
    sensitiveAction: false,
  }));
  await repository.revokeSessionBySecretHash({
    secretHash: hashForTest(replacement.cookieSecret),
    reason: "test_sign_out",
  });
  await assert.rejects(repository.findActorBySessionSecretHash({
    secretHash: hashForTest(replacement.cookieSecret),
    nowMs: Date.now(),
    sensitiveAction: false,
  }));
});

function localEnvironment(): Record<string, string | undefined> {
  return {
    APP_ENV: "development",
    APP_RUNTIME_MODE: "local-synthetic",
    AUTH_MODE: "database-test",
    NODE_ENV: "development",
  };
}

function hashForTest(secret: string): string {
  return createHash("sha256").update(Buffer.from(secret, "base64url")).digest("hex");
}
