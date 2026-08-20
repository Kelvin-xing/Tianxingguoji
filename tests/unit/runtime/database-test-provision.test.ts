import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DatabaseTestProvisionError,
  readDatabaseTestPasswordFromStream,
  readDatabaseTestProvisionTarget,
} from "../../../scripts/db/provision-database-test-identity.ts";

test("uses the canonical one-role Neon target", () => {
  assert.deepEqual(readDatabaseTestProvisionTarget(validEnvironment()), {
    connectionString: BASELINE_URL,
    loginUser: "tianxing_app",
    databaseName: "txgj_env01_test",
    connectionTimeoutMs: 5_000,
    statementTimeoutMs: 10_000,
  });
});

test("rejects legacy, Vercel, and non-test provision targets", () => {
  for (const environment of [
    { ...validEnvironment(), TEST_PROVISION_DATABASE_URL: BASELINE_URL },
    { ...validEnvironment(), TEST_MIGRATION_DATABASE_URL: BASELINE_URL },
    { ...validEnvironment(), VERCEL: "1" },
    { ...validEnvironment(), APP_ENV: "production" },
    { ...validEnvironment(), ONE_ROLE_BASELINE_DATABASE_URL:
      BASELINE_URL.replace("tianxing_app", "env01_migration_login") },
  ]) {
    assert.throws(() => readDatabaseTestProvisionTarget(environment), DatabaseTestProvisionError);
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

test("provision CLI requires the baseline marker and never recreates identities or database roles", async () => {
  const source = await readFile("scripts/db/provision-database-test-identity.ts", "utf8");
  assert.match(source, /ONE_ROLE_MARKER_SCHEMA/);
  assert.match(source, /ONE_ROLE_BASELINE_DATABASE_URL|readOneRoleBaselineTarget/);
  assert.doesNotMatch(source, /TEST_PROVISION_DATABASE_URL/);
  assert.doesNotMatch(source, /pg_has_role/);
  assert.doesNotMatch(source, /CREATE\s+ROLE|ALTER\s+ROLE/i);
  assert.doesNotMatch(source, /INSERT\s+INTO/i);
  assert.doesNotMatch(source, /identity_users\s*\(/i);
  assert.doesNotMatch(source, /access_organization_memberships\s*\(/i);
  assert.match(source, /identity_database_test_provision_credential/);
});

const BASELINE_URL =
  "postgresql://tianxing_app:synthetic-secret@ep-synthetic-123.c-2.us-east-1.aws.neon.tech:5432/txgj_env01_test";

function validEnvironment(): Record<string, string | undefined> {
  return {
    APP_ENV: "test",
    NODE_ENV: "production",
    ONE_ROLE_BASELINE_EXPECTED_DATABASE: "txgj_env01_test",
    ONE_ROLE_BASELINE_DATABASE_URL: BASELINE_URL,
  };
}

async function* streamOf(chunk: Buffer): AsyncIterable<Buffer> {
  yield chunk;
}
