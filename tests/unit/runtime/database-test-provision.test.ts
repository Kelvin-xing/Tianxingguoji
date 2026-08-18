import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DatabaseTestProvisionError,
  readDatabaseTestPasswordFromStream,
  readDatabaseTestProvisionTarget,
} from "../../../scripts/db/provision-database-test-identity.ts";

test("accepts only a bounded external provision login target", () => {
  assert.deepEqual(readDatabaseTestProvisionTarget(validEnvironment()), {
    connectionString:
      "postgresql://env01_provision_login:secret@db.vendor.example:5432/txgj_env01_test",
    loginUser: "env01_provision_login",
    connectionTimeoutMs: 2000,
    statementTimeoutMs: 5000,
  });
  for (const value of [
    "postgresql://tianxing_test_provisioner:secret@db.vendor.example:5432/txgj_env01_test",
    "postgresql://tianxing_test_application:secret@db.vendor.example:5432/txgj_env01_test",
    "postgresql://env01_provision_login:secret@127.0.0.1:5432/txgj_env01_test",
    "postgresql://env01_provision_login:secret@db.vendor.example:5432/tianxing",
    "postgresql://env01_provision_login:secret@db.vendor.example:5432/txgj_env01_test?sslmode=require",
  ]) {
    assert.throws(
      () => readDatabaseTestProvisionTarget({
        ...validEnvironment(),
        TEST_PROVISION_DATABASE_URL: value,
      }),
      DatabaseTestProvisionError,
    );
  }
});

test("uses the same frozen timeout boundaries as the Web runtime", () => {
  for (const [connection, statement] of [["250", "1000"], ["5000", "10000"]]) {
    const target = readDatabaseTestProvisionTarget({
      ...validEnvironment(),
      TEST_DATABASE_CONNECTION_TIMEOUT_MS: connection,
      TEST_DATABASE_STATEMENT_TIMEOUT_MS: statement,
    });
    assert.equal(target.connectionTimeoutMs, Number(connection));
    assert.equal(target.statementTimeoutMs, Number(statement));
  }

  for (const [variable, value] of [
    ["TEST_DATABASE_CONNECTION_TIMEOUT_MS", "249"],
    ["TEST_DATABASE_CONNECTION_TIMEOUT_MS", "5001"],
    ["TEST_DATABASE_STATEMENT_TIMEOUT_MS", "999"],
    ["TEST_DATABASE_STATEMENT_TIMEOUT_MS", "10001"],
  ] as const) {
    assert.throws(
      () => readDatabaseTestProvisionTarget({ ...validEnvironment(), [variable]: value }),
      DatabaseTestProvisionError,
    );
  }
});

test("clears collected password chunks when the stream exceeds the limit", async () => {
  const chunk = Buffer.alloc(258, 0x61);
  await assert.rejects(
    readDatabaseTestPasswordFromStream(streamOf(chunk)),
    DatabaseTestProvisionError,
  );
  assert.ok(chunk.every((byte) => byte === 0));
});

test("clears collected password chunks when stream iteration fails", async () => {
  const chunk = Buffer.from("temporary-secret");
  const failingStream: AsyncIterable<Buffer> = {
    async *[Symbol.asyncIterator]() {
      yield chunk;
      throw new Error("synthetic stream failure");
    },
  };
  await assert.rejects(
    readDatabaseTestPasswordFromStream(failingStream),
    DatabaseTestProvisionError,
  );
  assert.ok(chunk.every((byte) => byte === 0));
});

test("provision CLI requires stdin and never creates identity or business rows", async () => {
  const source = await readFile("scripts/db/provision-database-test-identity.ts", "utf8");
  assert.match(source, /"password-stdin"/);
  assert.match(source, /normalizeSyntheticEmail/);
  assert.match(source, /identity_database_test_lookup_provision_credential/);
  assert.match(source, /identity_database_test_provision_credential/);
  assert.doesNotMatch(source, /INSERT\s+INTO/i);
  assert.doesNotMatch(source, /identity_users\s*\(/i);
  assert.doesNotMatch(source, /access_organization_memberships\s*\(/i);
});

function validEnvironment(): Record<string, string | undefined> {
  return {
    APP_ENV: "test",
    NODE_ENV: "production",
    APP_RUNTIME_MODE: "test-database",
    AUTH_MODE: "database-test",
    TEST_DATABASE_EXPECTED_NAME: "txgj_env01_test",
    TEST_PROVISION_DATABASE_URL:
      "postgresql://env01_provision_login:secret@db.vendor.example:5432/txgj_env01_test",
    TEST_DATABASE_CONNECTION_TIMEOUT_MS: "2000",
    TEST_DATABASE_STATEMENT_TIMEOUT_MS: "5000",
  };
}

async function* streamOf(chunk: Buffer): AsyncIterable<Buffer> {
  yield chunk;
}
