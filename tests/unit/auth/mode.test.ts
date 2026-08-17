import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  AuthModeConfigurationError,
  loadAuthMode,
} from "../../../lib/auth/mode.ts";
import { LocalSyntheticLoginService } from "../../../modules/identity/local-synthetic-login.ts";
import { InMemoryIdentitySessionRepository } from "../../../modules/identity/session-repository.ts";

test("selects authentication adapters explicitly and blocks local auth in production", () => {
  assert.equal(loadAuthMode(localEnvironment()), "local-synthetic");
  assert.equal(loadAuthMode({ AUTH_MODE: "cognito", NODE_ENV: "development" }), "cognito");
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
    APP_RUNTIME_MODE: "local-synthetic",
    AUTH_MODE: "local-synthetic",
    NODE_ENV: "development",
  };
}

function hashForTest(secret: string): string {
  return createHash("sha256").update(Buffer.from(secret, "base64url")).digest("hex");
}
