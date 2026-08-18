import assert from "node:assert/strict";
import test from "node:test";

import { Pool } from "pg";

import { hashOpaqueSecret } from "../../modules/identity/application/opaque-secret.ts";
import {
  LOCAL_SYNTHETIC_ORGANIZATION,
  LOCAL_SYNTHETIC_PRINCIPALS,
  LocalSyntheticLoginService,
  PostgresqlLocalSyntheticSessionRepository,
} from "../../modules/identity/server.ts";
import { loadLocalSyntheticConfig } from "../../lib/runtime/local-synthetic-config.ts";

test("persists all local roles across repository restarts and revokes them", async () => {
  const connectionString = loadLocalSyntheticConfig().database.identityConnectionString;
  const firstPool = pool(connectionString, "local-identity-integration-first");
  const sessions: Array<{
    cookieSecret: string;
    role: string;
    sessionId: string;
  }> = [];

  try {
    const login = new LocalSyntheticLoginService(
      new PostgresqlLocalSyntheticSessionRepository(firstPool),
    );
    for (const principal of LOCAL_SYNTHETIC_PRINCIPALS) {
      const session = await login.createSession(principal.role);
      assert.equal(session.actor.userId, principal.userId);
      assert.equal(session.actor.organizationId, LOCAL_SYNTHETIC_ORGANIZATION.id);
      assert.equal(session.actor.role, principal.role);
      sessions.push({
        cookieSecret: session.cookieSecret,
        role: principal.role,
        sessionId: session.actor.sessionId,
      });
    }
  } finally {
    await firstPool.end();
  }

  const restartedPool = pool(connectionString, "local-identity-integration-restarted");
  const restartedRepository = new PostgresqlLocalSyntheticSessionRepository(restartedPool);
  try {
    for (const session of sessions) {
      const actor = await restartedRepository.findLegacyActorBySessionSecretHash({
        secretHash: hashOpaqueSecret(session.cookieSecret),
        nowMs: Date.now(),
        sensitiveAction: false,
      });
      assert.equal(actor.role, session.role);
      assert.equal(actor.sessionId, session.sessionId);
    }

    const client = await restartedPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.organization_id', $1, true)", [
        LOCAL_SYNTHETIC_ORGANIZATION.id,
      ]);
      const stored = await client.query<{
        session_kind: string;
        provider_token_ciphertext: Buffer | null;
        provider_token_key_version: string | null;
      }>(
        `SELECT session_kind, provider_token_ciphertext, provider_token_key_version
           FROM identity_sessions
          WHERE id = ANY($1::uuid[])
          ORDER BY id`,
        [sessions.map(({ sessionId }) => sessionId)],
      );
      assert.equal(stored.rows.length, LOCAL_SYNTHETIC_PRINCIPALS.length);
      for (const row of stored.rows) {
        assert.equal(row.session_kind, "local_synthetic");
        assert.equal(row.provider_token_ciphertext, null);
        assert.equal(row.provider_token_key_version, null);
      }
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }

    const expiring = sessions[0];
    assert.ok(expiring);
    await assert.rejects(
      restartedRepository.findActorBySessionSecretHash({
        secretHash: hashOpaqueSecret(expiring.cookieSecret),
        nowMs: Date.now() + 16 * 60 * 1_000,
        sensitiveAction: false,
      }),
    );
    const expiryClient = await restartedPool.connect();
    try {
      await expiryClient.query("BEGIN");
      await expiryClient.query("SELECT set_config('app.organization_id', $1, true)", [
        LOCAL_SYNTHETIC_ORGANIZATION.id,
      ]);
      const expired = await expiryClient.query<{ status: string }>(
        "SELECT status FROM identity_sessions WHERE id = $1",
        [expiring.sessionId],
      );
      assert.equal(expired.rows[0]?.status, "expired");
      await expiryClient.query("ROLLBACK");
    } finally {
      expiryClient.release();
    }
  } finally {
    for (const session of sessions) {
      await restartedRepository.revokeSessionBySecretHash({
        secretHash: hashOpaqueSecret(session.cookieSecret),
        reason: "integration_test_cleanup",
      });
    }
    await restartedPool.end();
  }
});

function pool(connectionString: string, applicationName: string): Pool {
  return new Pool({
    connectionString,
    application_name: applicationName,
    max: 2,
    connectionTimeoutMillis: 3_000,
    statement_timeout: 5_000,
    ssl: false,
  });
}
