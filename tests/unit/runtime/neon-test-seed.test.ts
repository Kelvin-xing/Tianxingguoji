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
  NEON_TEST_SEED_TABLE_COUNTS,
  NeonTestSeedSafetyError,
  PROHIBITED_NEON_TEST_SEED_TABLES,
  classifyNeonTestSeedPopulation,
  createNeonTestSeedEvidence,
  readNeonTestSeedMode,
  readNeonTestSeedTarget,
  readRelease1SyntheticSeedTarget,
  validateNeonTestRuntimeBoundary,
} from "../../../scripts/db/seed-neon-test-release1.ts";

const BASELINE_URL =
  "postgresql://tianxing_app:synthetic-secret@ep-synthetic-123.c-2.us-east-1.aws.neon.tech:5432/txgj_env01_test";

test("requires one explicit Neon seed mode and the canonical baseline target", () => {
  assert.equal(readNeonTestSeedMode(["--dry-run"]), "dry-run");
  assert.equal(readNeonTestSeedMode(["--apply"]), "apply");
  assert.throws(() => readNeonTestSeedMode([]), NeonTestSeedSafetyError);
  assert.deepEqual(readNeonTestSeedTarget(validEnvironment()), {
    connectionString: BASELINE_URL,
    host: "ep-synthetic-123.c-2.us-east-1.aws.neon.tech",
    port: 5432,
    database: "txgj_env01_test",
    user: "tianxing_app",
    ssl: { rejectUnauthorized: true },
  });
  assert.throws(
    () => readNeonTestSeedTarget({ ...validEnvironment(), VERCEL: "1" }),
    NeonTestSeedSafetyError,
  );
});

test("uses the same Release 1 synthetic seed definition on the loopback local baseline", () => {
  assert.deepEqual(readRelease1SyntheticSeedTarget(localEnvironment()), {
    connectionString:
      "postgresql://tianxing_app:synthetic-secret@127.0.0.1:5432/tianxing",
    host: "127.0.0.1",
    port: 5432,
    database: "tianxing",
    user: "tianxing_app",
    ssl: false,
  });
  assert.throws(
    () => readNeonTestSeedTarget(localEnvironment()),
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
    "advisor",
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
    task_policies: 1,
    task_rules: 8,
  });
  assert.deepEqual(NEON_TEST_SEED_TABLE_COUNTS, {
    access_organizations: 1,
    identity_users: 5,
    access_organization_memberships: 5,
    access_role_bindings: 5,
    crm_students: 2,
    crm_guardians: 2,
    crm_student_guardian_relationships: 2,
    cases_schema_manifests: 1,
    cases_schema_manifest_fields: 15,
    schools_schools: 3,
    schools_snapshots: 1,
    schools_snapshot_records: 3,
    tasks_transition_policies: 1,
    tasks_transition_rules: 8,
  });
  assert.deepEqual(PROHIBITED_NEON_TEST_SEED_TABLES, [
    "identity_database_test_credentials",
    "identity_sessions",
    "cases_service_cases",
    "documents_documents",
    "portal_access_grants",
    "audit_events",
    "audit_outbox",
  ]);
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

test("validates the single owner role and preserves the credential owner residual risk", () => {
  const valid = {
    userName: "tianxing_app",
    databaseOwner: "tianxing_app",
    login: true,
    superuser: false,
    createDatabase: false,
    createRole: false,
    inherit: false,
    replication: false,
    bypassRls: false,
    credentialTableOwner: "tianxing_app",
  } as const;
  assert.doesNotThrow(() => validateNeonTestRuntimeBoundary(valid));
  assert.throws(
    () => validateNeonTestRuntimeBoundary({
      ...valid,
      createRole: true,
    }),
    NeonTestSeedSafetyError,
  );
});

test("does not import local seeds or create credentials, sessions, cases, or evidence", async () => {
  const [fixtureSource, seedSource, packageJsonSource] = await Promise.all([
    readFile("scripts/db/neon-test-synthetic-fixture.ts", "utf8"),
    readFile("scripts/db/seed-neon-test-release1.ts", "utf8"),
    readFile("package.json", "utf8"),
  ]);
  const combined = `${fixtureSource}\n${seedSource}`;
  assert.doesNotMatch(combined, /seed-local-identity|seed-local-release1/);
  assert.doesNotMatch(combined, /LOCAL_SYNTHETIC_ORGANIZATION|LOCAL_SYNTHETIC_PRINCIPALS/);
  assert.doesNotMatch(combined, /local\.invalid|tianxing-local-/);
  for (const table of PROHIBITED_NEON_TEST_SEED_TABLES) {
    assert.doesNotMatch(combined, new RegExp(`INSERT\\s+INTO\\s+${table}`, "i"));
  }
  assert.doesNotMatch(combined, /error\.stack/);
  assert.doesNotMatch(seedSource, /migration\.schema_migrations|EXPECTED_PUBLIC_TABLES/);
  assert.match(seedSource, /ONE_ROLE_MARKER_SCHEMA/);
  assert.match(seedSource, /ONE_ROLE_MARKER_TABLE/);
  assert.match(seedSource, /ONE_ROLE_BASELINE_DATABASE_URL/);
  assert.match(seedSource, /set_config\('app\.organization_id'/);
  assert.match(seedSource, /set_config\('app\.actor_user_id'/);
  const packageJson = JSON.parse(packageJsonSource) as {
    scripts?: Readonly<Record<string, string>>;
  };
  assert.equal(
    packageJson.scripts?.["test:neon-test-seed-postgresql"],
    "node --test tests/integration/neon-test-seed-postgresql.test.ts",
  );
  assert.equal(
    packageJson.scripts?.["db:seed:local-release1"],
    "node --env-file=.env.migration.local scripts/db/seed-neon-test-release1.ts --apply",
  );
  assert.equal(packageJson.scripts?.["db:seed:local-identity"], "pnpm db:seed:local-release1");
});

test("emits aggregate seed evidence without rows, email, hostname, or secrets", () => {
  const output = JSON.stringify(createNeonTestSeedEvidence("apply", "a".repeat(64), 63, {
    manifestContentSha256: "b".repeat(64),
    schoolSnapshotManifestSha256: "c".repeat(64),
  }));
  assert.match(output, /"version":"env01-neon-release1-v1"/);
  assert.match(output, /"users":5/);
  assert.match(output, /"synthetic_only":true/);
  assert.match(output, /"canonical_login_role":"tianxing_app"/);
  assert.match(output, /"credential_table_owner_access_is_residual_risk":true/);
  assert.match(output, new RegExp(`"manifest_content_sha256":"${"b".repeat(64)}"`));
  assert.match(output, new RegExp(`"school_snapshot_manifest_sha256":"${"c".repeat(64)}"`));
  assert.doesNotMatch(output, /@|email|ep-synthetic|synthetic-secret|postgresql:\/\//i);
  assert.doesNotMatch(output, /hostname|connectionString|password/i);
});

function validEnvironment(): Record<string, string | undefined> {
  return {
    APP_ENV: "test",
    NODE_ENV: "production",
    ONE_ROLE_BASELINE_EXPECTED_DATABASE: "txgj_env01_test",
    ONE_ROLE_BASELINE_DATABASE_URL: BASELINE_URL,
  };
}

function localEnvironment(): Record<string, string | undefined> {
  return {
    APP_ENV: "development",
    NODE_ENV: "development",
    ONE_ROLE_BASELINE_EXPECTED_DATABASE: "tianxing",
    ONE_ROLE_BASELINE_DATABASE_URL:
      "postgresql://tianxing_app:synthetic-secret@127.0.0.1:5432/tianxing",
  };
}

function zeroSeedCounts(): Record<keyof typeof NEON_TEST_SEED_COUNTS, number> {
  return Object.fromEntries(
    Object.keys(NEON_TEST_SEED_COUNTS).map((name) => [name, 0]),
  ) as Record<keyof typeof NEON_TEST_SEED_COUNTS, number>;
}
