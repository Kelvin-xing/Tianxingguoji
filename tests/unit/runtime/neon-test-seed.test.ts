import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  NEON_TEST_ORGANIZATION,
  NEON_TEST_PRINCIPALS,
  NEON_TEST_SCHOOLS,
  NEON_TEST_SEED_VERSION,
  NEON_TEST_STUDENTS,
  loadNeonTestManifestFixture,
} from "../../../scripts/db/neon-test-synthetic-fixture.ts";
import {
  NEON_TEST_SEED_COUNTS,
  NeonTestSeedSafetyError,
  classifyNeonTestSeedPopulation,
  createNeonTestSeedEvidence,
  readNeonTestSeedMode,
  readNeonTestSeedTarget,
  validateNeonTestRuntimeBoundary,
} from "../../../scripts/db/seed-neon-test-release1.ts";

const MIGRATION_URL =
  "postgresql://env01_migration_login:synthetic-secret@ep-synthetic-123.us-east-1.aws.neon.tech:5432/txgj_env01_test";

test("requires one explicit Neon seed mode and the migration owner target", () => {
  assert.equal(readNeonTestSeedMode(["--dry-run"]), "dry-run");
  assert.equal(readNeonTestSeedMode(["--apply"]), "apply");
  assert.throws(() => readNeonTestSeedMode([]), NeonTestSeedSafetyError);
  assert.deepEqual(readNeonTestSeedTarget(validEnvironment()), {
    connectionString: MIGRATION_URL,
    host: "ep-synthetic-123.us-east-1.aws.neon.tech",
    port: 5432,
    database: "txgj_env01_test",
    user: "env01_migration_login",
  });
  assert.throws(
    () => readNeonTestSeedTarget({ ...validEnvironment(), VERCEL: "1" }),
    NeonTestSeedSafetyError,
  );
});

test("defines the exact independent ENV01 synthetic fixture counts", () => {
  assert.equal(NEON_TEST_SEED_VERSION, "env01-neon-release1-v1");
  assert.equal(NEON_TEST_ORGANIZATION.displayName, "Tianxing Vercel Test Synthetic");
  assert.equal(NEON_TEST_PRINCIPALS.length, 5);
  assert.deepEqual(NEON_TEST_PRINCIPALS.map(({ role }) => role), [
    "founder",
    "admin",
    "advisor",
    "data_reviewer",
    "contractor",
  ]);
  assert.equal(NEON_TEST_STUDENTS.length, 2);
  assert.equal(NEON_TEST_SCHOOLS.length, 3);
  assert.deepEqual(NEON_TEST_SEED_COUNTS, {
    organizations: 1,
    users: 5,
    memberships: 5,
    role_bindings: 5,
    students: 2,
    guardians: 2,
    relationships: 2,
    assessment_manifests: 1,
    manifest_fields: 15,
    schools: 3,
    school_snapshots: 1,
    school_records: 3,
  });
});

test("uses only visibly synthetic invalid-domain data and fixed unique UUIDs", () => {
  const identifiers = [
    NEON_TEST_ORGANIZATION.id,
    ...NEON_TEST_PRINCIPALS.flatMap(({ userId, membershipId, roleBindingId }) => [
      userId,
      membershipId,
      roleBindingId,
    ]),
    ...NEON_TEST_STUDENTS.flatMap(({ id, guardianId, relationshipId }) => [
      id,
      guardianId,
      relationshipId,
    ]),
    ...NEON_TEST_SCHOOLS.flatMap(({ id, recordId }) => [id, recordId]),
  ];
  assert.equal(new Set(identifiers).size, identifiers.length);
  for (const identifier of identifiers) assert.match(identifier, /^[0-9a-f-]{36}$/);
  for (const principal of NEON_TEST_PRINCIPALS) {
    assert.match(principal.email, /@env01\.test\.invalid$/);
  }
  for (const student of NEON_TEST_STUDENTS) {
    assert.match(student.displayName, /ENV01 Synthetic/);
    assert.match(student.guardianName, /ENV01 Synthetic/);
    assert.equal(student.contactPhone, null);
    assert.equal(student.guardianPhone, null);
    if (student.contactEmail) assert.match(student.contactEmail, /\.invalid$/);
    assert.match(student.guardianEmail, /\.invalid$/);
  }
  for (const school of NEON_TEST_SCHOOLS) {
    assert.match(school.fields.school_name_en, /ENV01 Synthetic/);
    assert.match(school.fields.official_website, /^https:\/\/[^/]+\.invalid$/);
  }
});

test("composes exactly one approved 15-field K12 manifest", async () => {
  const fixture = await loadNeonTestManifestFixture();
  assert.equal(fixture.modules.length, 4);
  assert.equal(fixture.fields.length, 15);
  assert.match(fixture.contentSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual([...fixture.modulesByLayer.keys()].sort(), [
    "admission_route",
    "base",
    "education_stage",
    "school_system",
  ]);
  assert.ok(fixture.modules.every(({ catalogueStatus }) => catalogueStatus === "approved"));
});

test("accepts only an empty or complete fixed seed population", () => {
  assert.equal(
    classifyNeonTestSeedPopulation(zeroSeedCounts()),
    "empty",
  );
  assert.equal(
    classifyNeonTestSeedPopulation({ ...NEON_TEST_SEED_COUNTS }),
    "existing",
  );
  assert.throws(
    () => classifyNeonTestSeedPopulation({ ...NEON_TEST_SEED_COUNTS, students: 1 }),
    NeonTestSeedSafetyError,
  );
});

test("defines the future identity and application runtime privilege verifier", () => {
  const valid = {
    identity: {
      memberOfExpectedGroup: true,
      canReadCredentials: true,
      canWriteBusinessData: false,
      canRunDdl: false,
    },
    application: {
      memberOfExpectedGroup: true,
      canReadBusinessData: true,
      canWriteBusinessData: true,
      canReadCredentials: false,
      canRunDdl: false,
    },
  } as const;
  assert.doesNotThrow(() => validateNeonTestRuntimeBoundary(valid));
  assert.throws(
    () => validateNeonTestRuntimeBoundary({
      ...valid,
      application: { ...valid.application, canReadCredentials: true },
    }),
    NeonTestSeedSafetyError,
  );
});

test("does not import local seeds or create credentials, sessions, cases, or evidence", async () => {
  const [fixtureSource, seedSource] = await Promise.all([
    readFile("scripts/db/neon-test-synthetic-fixture.ts", "utf8"),
    readFile("scripts/db/seed-neon-test-release1.ts", "utf8"),
  ]);
  const combined = `${fixtureSource}\n${seedSource}`;
  assert.doesNotMatch(combined, /seed-local-identity|seed-local-release1/);
  assert.doesNotMatch(combined, /LOCAL_SYNTHETIC_ORGANIZATION|LOCAL_SYNTHETIC_PRINCIPALS/);
  assert.doesNotMatch(combined, /local\.invalid|tianxing-local-/);
  for (const table of [
    "identity_database_test_credentials",
    "identity_sessions",
    "cases_service_cases",
    "documents_documents",
    "portal_access_grants",
    "audit_events",
    "audit_outbox",
  ]) {
    assert.doesNotMatch(combined, new RegExp(`INSERT\\s+INTO\\s+${table}`, "i"));
  }
  assert.doesNotMatch(combined, /error\.stack/);
});

test("emits aggregate seed evidence without rows, email, hostname, or secrets", () => {
  const output = JSON.stringify(createNeonTestSeedEvidence("apply", "a".repeat(64), {
    manifestContentSha256: "b".repeat(64),
    schoolSnapshotManifestSha256: "c".repeat(64),
  }));
  assert.match(output, /"version":"env01-neon-release1-v1"/);
  assert.match(output, /"users":5/);
  assert.match(output, /"synthetic_only":true/);
  assert.match(output, new RegExp(`"manifest_content_sha256":"${"b".repeat(64)}"`));
  assert.match(output, new RegExp(`"school_snapshot_manifest_sha256":"${"c".repeat(64)}"`));
  assert.doesNotMatch(output, /@|email|ep-synthetic|synthetic-secret|postgresql:\/\//i);
  assert.doesNotMatch(output, /hostname|connectionString|password/i);
});

function validEnvironment(): Record<string, string | undefined> {
  return {
    APP_ENV: "test",
    NODE_ENV: "production",
    APP_RUNTIME_MODE: "test-database",
    AUTH_MODE: "database-test",
    TEST_DATABASE_EXPECTED_NAME: "txgj_env01_test",
    TEST_MIGRATION_DATABASE_URL: MIGRATION_URL,
  };
}

function zeroSeedCounts(): Record<keyof typeof NEON_TEST_SEED_COUNTS, number> {
  return Object.fromEntries(
    Object.keys(NEON_TEST_SEED_COUNTS).map((name) => [name, 0]),
  ) as Record<keyof typeof NEON_TEST_SEED_COUNTS, number>;
}
