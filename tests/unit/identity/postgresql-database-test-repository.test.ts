import assert from "node:assert/strict";
import test from "node:test";

import {
  DatabaseTestIdentityRoleError,
  DatabaseTestRepositoryUnavailable,
  PostgresqlDatabaseTestSessionRepository,
  type DatabaseTestIdentityClient,
} from "../../../modules/identity/infrastructure/postgresql-database-test-repository.ts";

const LOGIN_USER = "tianxing_app";

test("reads only the fixed scrypt-v1 credential shape after canonical login preflight", async () => {
  const client = fakeClient((sql) => {
    if (sql.includes("SELECT current_user")) {
      return [{ current_user: LOGIN_USER }];
    }
    if (sql.includes("lookup_credential")) {
      return [{
        user_id: "10000000-0000-4000-8000-000000000001",
        verifier_version: "scrypt-v1",
        password_salt: Buffer.alloc(32, 1),
        password_verifier: Buffer.alloc(64, 2),
        credential_version: "7",
      }];
    }
    return [];
  });
  const repository = new PostgresqlDatabaseTestSessionRepository(
    { connect: async () => client },
    LOGIN_USER,
  );

  const credential = await repository.findCredential("user@example.invalid");
  assert.equal(credential?.credentialVersion, 7);
  assert.equal(credential?.salt.byteLength, 32);
  assert.equal(credential?.verifier.byteLength, 64);
  assert.ok(client.sql.some((sql) => sql.includes("identity_database_test_lookup_credential")));
});

test("returns the exact actor from a version-CAS complete-login function", async () => {
  const client = fakeClient((sql) => {
    if (sql.includes("SELECT current_user")) {
      return [{ current_user: LOGIN_USER }];
    }
    if (sql.includes("FROM public.access_organizations")) {
      return [{ organization_id: "10000000-0000-4000-8000-000000000002" }];
    }
    if (sql.includes("FROM public.identity_users AS identity_user")) {
      return [{
        membership_id: "10000000-0000-4000-8000-000000000003",
        role_binding_id: "10000000-0000-4000-8000-000000000004",
      }];
    }
    if (sql.includes("complete_login")) return [actorRow()];
    return [];
  });
  const repository = new PostgresqlDatabaseTestSessionRepository(
    { connect: async () => client },
    LOGIN_USER,
  );
  const actor = await repository.completeLoginAttempt({
    userId: "10000000-0000-4000-8000-000000000001",
    expectedCredentialVersion: 7,
    passwordMatched: true,
    sessionId: "10000000-0000-4000-8000-000000000006",
    secretHash: "a".repeat(64),
    nowMs: 1_800_000_000_000,
  });
  assert.deepEqual(actor, {
    userId: "10000000-0000-4000-8000-000000000001",
    normalizedEmail: "user@example.invalid",
    organizationId: "10000000-0000-4000-8000-000000000002",
    membershipId: "10000000-0000-4000-8000-000000000003",
    roleBindingId: "10000000-0000-4000-8000-000000000004",
    role: "advisor",
    sessionId: "10000000-0000-4000-8000-000000000006",
    capturedSessionVersion: 4,
    reauthenticatedAtMs: 1_800_000_000_000,
  });
  const advisoryIndex = client.sql.findIndex((sql) => sql.includes("pg_advisory_xact_lock"));
  const organizationIndex = client.sql.findIndex((sql) => sql.includes("access_organizations"));
  assert.ok(advisoryIndex >= 0 && advisoryIndex < organizationIndex);
  assert.deepEqual(
    client.sql.filter((sql) => sql.includes("set_config") || sql.includes("complete_login")),
    [
      "SELECT set_config('app.organization_id', $1, true)",
      "SELECT set_config('app.actor_user_id', $1, true)",
      `SELECT * FROM identity_database_test_complete_login(
           $1, $2, $3, $4, $5, $6
         )`,
    ],
  );
});

test("derives tenant and actor context from server-side identity data only after password match", async () => {
  const client = fakeClient((sql) => {
    if (sql.includes("SELECT current_user")) return [{ current_user: LOGIN_USER }];
    if (sql.includes("complete_login")) return [];
    return [];
  });
  const repository = new PostgresqlDatabaseTestSessionRepository(
    { connect: async () => client },
    LOGIN_USER,
  );

  await repository.completeLoginAttempt({
    userId: "10000000-0000-4000-8000-000000000001",
    expectedCredentialVersion: 7,
    passwordMatched: false,
    sessionId: "10000000-0000-4000-8000-000000000006",
    secretHash: "a".repeat(64),
    nowMs: 1_800_000_000_000,
  });

  assert.equal(client.sql.some((sql) => sql.includes("access_organizations")), false);
  assert.equal(client.sql.some((sql) => sql.includes("pg_advisory_xact_lock")), false);
  assert.equal(client.sql.some((sql) => sql.includes("set_config")), false);
  assert.equal(client.sql.some((sql) => sql.includes("complete_login")), true);
});

test("sets session tenant and actor context before resolving an opaque session", async () => {
  const client = fakeClient((sql) => {
    if (sql.includes("SELECT current_user")) return [{ current_user: LOGIN_USER }];
    if (sql.includes("FROM public.access_organizations")) {
      return [{ organization_id: "10000000-0000-4000-8000-000000000002" }];
    }
    if (sql.includes("FROM public.identity_sessions AS session")) {
      return [{ user_id: "10000000-0000-4000-8000-000000000001" }];
    }
    if (sql.includes("resolve_session")) return [actorRow()];
    return [];
  });
  const repository = new PostgresqlDatabaseTestSessionRepository(
    { connect: async () => client },
    LOGIN_USER,
  );

  const actor = await repository.findActorBySessionSecretHash({
    secretHash: "b".repeat(64),
    nowMs: 1_800_000_000_000,
    sensitiveAction: false,
  });

  assert.equal(actor.userId, "10000000-0000-4000-8000-000000000001");
  const contextIndex = client.sql.findIndex((sql) => sql.includes("app.actor_user_id"));
  const resolveIndex = client.sql.findIndex((sql) => sql.includes("resolve_session"));
  assert.ok(contextIndex >= 0 && contextIndex < resolveIndex);
});

test("sets session tenant and actor context before revoking an opaque session", async () => {
  const client = fakeClient((sql) => {
    if (sql.includes("SELECT current_user")) return [{ current_user: LOGIN_USER }];
    if (sql.includes("FROM public.access_organizations")) {
      return [{ organization_id: "10000000-0000-4000-8000-000000000002" }];
    }
    if (sql.includes("FROM public.identity_sessions AS session")) {
      return [{ user_id: "10000000-0000-4000-8000-000000000001" }];
    }
    return [];
  });
  const repository = new PostgresqlDatabaseTestSessionRepository(
    { connect: async () => client },
    LOGIN_USER,
  );

  await repository.revokeSessionBySecretHash({
    secretHash: "b".repeat(64),
    reason: "logout",
  });

  const contextIndex = client.sql.findIndex((sql) => sql.includes("app.actor_user_id"));
  const revokeIndex = client.sql.findIndex((sql) => sql.includes("revoke_session"));
  assert.ok(contextIndex >= 0 && contextIndex < revokeIndex);
});

test("fails closed before complete-login when the verified user has no unique eligible binding", async () => {
  const client = fakeClient((sql) => {
    if (sql.includes("SELECT current_user")) return [{ current_user: LOGIN_USER }];
    if (sql.includes("FROM public.access_organizations")) {
      return [{ organization_id: "10000000-0000-4000-8000-000000000002" }];
    }
    if (sql.includes("FROM public.identity_users AS identity_user")) return [];
    return [];
  });
  const repository = new PostgresqlDatabaseTestSessionRepository(
    { connect: async () => client },
    LOGIN_USER,
  );

  const actor = await repository.completeLoginAttempt({
    userId: "10000000-0000-4000-8000-000000000001",
    expectedCredentialVersion: 7,
    passwordMatched: true,
    sessionId: "10000000-0000-4000-8000-000000000006",
    secretHash: "a".repeat(64),
    nowMs: 1_800_000_000_000,
  });

  assert.equal(actor, null);
  assert.equal(client.sql.some((sql) => sql.includes("complete_login")), false);
});

test("distinguishes a role configuration failure from an unavailable repository", async () => {
  const wrongRole = fakeClient((sql) => sql.includes("SELECT current_user")
    ? [{ current_user: "wrong_login" }]
    : []);
  await assert.rejects(
    new PostgresqlDatabaseTestSessionRepository(
      { connect: async () => wrongRole },
      LOGIN_USER,
    ).findCredential("user@example.invalid"),
    DatabaseTestIdentityRoleError,
  );

  const unavailable = fakeClient((sql) => {
    if (sql.includes("SELECT current_user")) {
      return [{ current_user: LOGIN_USER }];
    }
    if (sql.includes("lookup_credential")) throw new Error("connection closed");
    return [];
  });
  await assert.rejects(
    new PostgresqlDatabaseTestSessionRepository(
      { connect: async () => unavailable },
      LOGIN_USER,
    ).findCredential("user@example.invalid"),
    DatabaseTestRepositoryUnavailable,
  );
});

function fakeClient(
  rows: (sql: string, values?: readonly unknown[]) => readonly Record<string, unknown>[],
): DatabaseTestIdentityClient & { sql: string[] } {
  const sql: string[] = [];
  return {
    sql,
    async query<Row>(text: string, values?: readonly unknown[]) {
      sql.push(text);
      return { rows: rows(text, values) as Row[] };
    },
    release() {},
  };
}

function actorRow(): Record<string, unknown> {
  return {
    allowed: true,
    user_id: "10000000-0000-4000-8000-000000000001",
    normalized_email: "user@example.invalid",
    organization_id: "10000000-0000-4000-8000-000000000002",
    membership_id: "10000000-0000-4000-8000-000000000003",
    role_binding_id: "10000000-0000-4000-8000-000000000004",
    role: "advisor",
    session_id: "10000000-0000-4000-8000-000000000006",
    captured_session_version: "4",
    reauthenticated_at: new Date(1_800_000_000_000),
  };
}
