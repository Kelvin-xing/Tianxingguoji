import assert from "node:assert/strict";
import test from "node:test";

import {
  DatabaseTestIdentityRoleError,
  DatabaseTestRepositoryUnavailable,
  PostgresqlDatabaseTestSessionRepository,
  type DatabaseTestIdentityClient,
} from "../../../modules/identity/infrastructure/postgresql-database-test-repository.ts";

const LOGIN_USER = "env01_identity_login";

test("reads only the fixed scrypt-v1 credential shape after role membership preflight", async () => {
  const client = fakeClient((sql) => {
    if (sql.includes("pg_has_role")) {
      return [{ current_user: LOGIN_USER, has_required_role: true }];
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
    if (sql.includes("pg_has_role")) {
      return [{ current_user: LOGIN_USER, has_required_role: true }];
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
});

test("distinguishes a role configuration failure from an unavailable repository", async () => {
  const wrongRole = fakeClient((sql) => sql.includes("pg_has_role")
    ? [{ current_user: "wrong_login", has_required_role: false }]
    : []);
  await assert.rejects(
    new PostgresqlDatabaseTestSessionRepository(
      { connect: async () => wrongRole },
      LOGIN_USER,
    ).findCredential("user@example.invalid"),
    DatabaseTestIdentityRoleError,
  );

  const unavailable = fakeClient((sql) => {
    if (sql.includes("pg_has_role")) {
      return [{ current_user: LOGIN_USER, has_required_role: true }];
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
