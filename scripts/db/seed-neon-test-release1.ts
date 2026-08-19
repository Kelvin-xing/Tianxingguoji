import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { Client } from "pg";

import {
  EXPECTED_MIGRATION_COUNT,
  NEON_TEST_DATABASE,
  NEON_TEST_MIGRATION_LOGIN,
  assertNeonTestManifest,
  verifyOrderedMigrationManifest,
} from "./migration-manifest.ts";
import {
  NEON_TEST_MANIFEST_COMPOSITION_VERSION,
  NEON_TEST_MANIFEST_ID,
  NEON_TEST_ORGANIZATION,
  NEON_TEST_PRINCIPALS,
  NEON_TEST_SCHOOLS,
  NEON_TEST_SCHOOL_SNAPSHOT_ID,
  NEON_TEST_SCHOOL_SOURCE_RELEASE_ID,
  NEON_TEST_SEED_VERSION,
  NEON_TEST_STUDENTS,
  loadNeonTestManifestFixture,
  neonTestSchoolSnapshotManifestSha256,
  type NeonTestManifestFixture,
} from "./neon-test-synthetic-fixture.ts";
import {
  readNeonTestMigrationTarget,
  type NeonTestMigrationTarget,
} from "./run-neon-test-migrations.ts";

const EXPECTED_PUBLIC_TABLES = 63;
const PROHIBITED_SEED_TABLES = Object.freeze([
  "identity_database_test_credentials",
  "identity_sessions",
  "cases_service_cases",
  "documents_documents",
  "portal_access_grants",
  "audit_events",
  "audit_outbox",
] as const);
const REDACTED_ENVIRONMENT_VARIABLES = Object.freeze([
  "APP_ENV",
  "NODE_ENV",
  "APP_RUNTIME_MODE",
  "AUTH_MODE",
  "TEST_DATABASE_EXPECTED_NAME",
  "TEST_MIGRATION_DATABASE_URL",
  "DATABASE_URL",
  "MIGRATION_DATABASE_URL",
  "TEST_IDENTITY_DATABASE_URL",
  "TEST_APPLICATION_DATABASE_URL",
  "TEST_PROVISION_DATABASE_URL",
  "VERCEL",
  "VERCEL_ENV",
] as const);

export const NEON_TEST_SEED_COUNTS = Object.freeze({
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

export type NeonTestSeedMode = "dry-run" | "apply";
export type NeonTestSeedPopulation = "empty" | "existing";
export type NeonTestRuntimeBoundaryObservation = Readonly<{
  identity: Readonly<{
    memberOfExpectedGroup: boolean;
    canReadCredentials: boolean;
    canWriteBusinessData: boolean;
    canRunDdl: boolean;
  }>;
  application: Readonly<{
    memberOfExpectedGroup: boolean;
    canReadBusinessData: boolean;
    canWriteBusinessData: boolean;
    canReadCredentials: boolean;
    canRunDdl: boolean;
  }>;
}>;
type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

export class NeonTestSeedSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NeonTestSeedSafetyError";
  }
}

export function readNeonTestSeedMode(arguments_: readonly string[]): NeonTestSeedMode {
  if (arguments_.length !== 1 || !["--dry-run", "--apply"].includes(arguments_[0] ?? "")) {
    throw new NeonTestSeedSafetyError(
      "Specify exactly one Neon seed mode: --dry-run or --apply.",
    );
  }
  return arguments_[0] === "--apply" ? "apply" : "dry-run";
}

export function readNeonTestSeedTarget(
  environment: RuntimeEnvironment = process.env,
): NeonTestMigrationTarget {
  try {
    return readNeonTestMigrationTarget(environment);
  } catch {
    throw new NeonTestSeedSafetyError("Neon seed target is invalid.");
  }
}

export function createNeonTestSeedEvidence(
  mode: NeonTestSeedMode,
  migrationManifestSha256: string,
  fixtureHashes: Readonly<{
    manifestContentSha256: string;
    schoolSnapshotManifestSha256: string;
  }>,
) {
  return Object.freeze({
    mode,
    endpoint_kind: "neon-direct",
    target_database: NEON_TEST_DATABASE,
    migration_login: NEON_TEST_MIGRATION_LOGIN,
    tls: Object.freeze({ verified: true, reject_unauthorized: true }),
    manifest: Object.freeze({
      version: 1,
      count: EXPECTED_MIGRATION_COUNT,
      sha256: migrationManifestSha256,
    }),
    ledger: Object.freeze({ before: EXPECTED_MIGRATION_COUNT, after: EXPECTED_MIGRATION_COUNT }),
    public_table_count: Object.freeze({ before: EXPECTED_PUBLIC_TABLES, after: EXPECTED_PUBLIC_TABLES }),
    seed: Object.freeze({
      version: NEON_TEST_SEED_VERSION,
      synthetic_only: true,
      manifest_content_sha256: fixtureHashes.manifestContentSha256,
      school_snapshot_manifest_sha256: fixtureHashes.schoolSnapshotManifestSha256,
      rows: NEON_TEST_SEED_COUNTS,
    }),
    status: "pass",
  });
}

export async function seedNeonTestRelease1(
  target: NeonTestMigrationTarget,
  mode: NeonTestSeedMode,
) {
  const manifest = await verifyOrderedMigrationManifest();
  assertNeonTestManifest(manifest);
  const fixture = await loadNeonTestManifestFixture();
  const client = new Client({
    connectionString: target.connectionString,
    application_name: "tianxing-neon-test-release1-seed",
    connectionTimeoutMillis: 5_000,
    query_timeout: 10_000,
    ssl: { rejectUnauthorized: true },
  });
  await client.connect();
  try {
    await assertSeedPreflight(client, target, manifest.migrations.map(({ name }) => name.replace(/\.sql$/, "")));
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    let populationBefore: NeonTestSeedPopulation | undefined;
    try {
      await lockSeedTables(client);
      populationBefore = await inspectSeedPopulation(client);
      if (populationBefore === "empty") {
        await insertIdentityAndAccess(client);
        await insertStudentsAndGuardians(client);
        await insertApprovedManifest(client, fixture);
        await insertSchools(client);
      }
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      await assertExactSeedContent(client, fixture);
      if (mode === "dry-run") {
        await client.query("ROLLBACK");
      } else {
        await client.query("COMMIT");
      }
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }

    const populationAfter = await inspectSeedPopulation(client);
    if (mode === "dry-run" && populationAfter !== populationBefore) {
      throw new NeonTestSeedSafetyError("Neon seed dry-run changed the pre-existing seed state.");
    }
    if (mode === "apply" && populationAfter !== "existing") {
      throw new NeonTestSeedSafetyError("Neon seed apply did not produce the complete fixed fixture.");
    }
    if (populationAfter === "existing") await assertExactSeedContent(client, fixture);

    return createNeonTestSeedEvidence(mode, manifest.manifestSha256, {
      manifestContentSha256: fixture.contentSha256,
      schoolSnapshotManifestSha256: neonTestSchoolSnapshotManifestSha256(),
    });
  } finally {
    await client.end();
  }
}

async function assertSeedPreflight(
  client: Client,
  target: NeonTestMigrationTarget,
  expectedLedger: readonly string[],
): Promise<void> {
  const identity = await client.query<{
    database_name: string;
    user_name: string;
    database_owner: string;
    rolsuper: boolean;
    rolcreaterole: boolean;
    rolcreatedb: boolean;
    rolreplication: boolean;
    rolbypassrls: boolean;
    member_of_neon_superuser: boolean;
  }>(`
    SELECT current_database() AS database_name,
           current_user AS user_name,
           pg_get_userbyid(database.datdba) AS database_owner,
           role.rolsuper,
           role.rolcreaterole,
           role.rolcreatedb,
           role.rolreplication,
           role.rolbypassrls,
           pg_has_role(role.rolname, 'neon_superuser', 'member')
             AS member_of_neon_superuser
      FROM pg_database AS database
      JOIN pg_roles AS role ON role.rolname = current_user
     WHERE database.datname = current_database()
  `);
  const current = identity.rows[0];
  if (
    !current ||
    current.database_name !== target.database ||
    current.user_name !== target.user ||
    current.database_owner !== target.user ||
    current.rolsuper ||
    !current.rolcreaterole ||
    current.rolcreatedb ||
    current.rolreplication ||
    current.rolbypassrls ||
    current.member_of_neon_superuser
  ) {
    throw new NeonTestSeedSafetyError("Connected seed identity is not the approved database owner.");
  }

  const ledger = await client.query<{ name: string }>(
    "SELECT name FROM migration.schema_migrations ORDER BY run_on, id",
  );
  const applied = ledger.rows.map(({ name }) => name);
  if (
    applied.length !== EXPECTED_MIGRATION_COUNT ||
    applied.some((name, index) => name !== expectedLedger[index])
  ) {
    throw new NeonTestSeedSafetyError("Neon seed requires the complete ordered migration ledger.");
  }

  const publicTables = await client.query<{ count: string }>(`
    SELECT count(*)::text AS count FROM pg_tables WHERE schemaname = 'public'
  `);
  if (Number(publicTables.rows[0]?.count ?? "0") !== EXPECTED_PUBLIC_TABLES) {
    throw new NeonTestSeedSafetyError("Neon seed requires the expected migrated public schema.");
  }
}

export function classifyNeonTestSeedPopulation(
  counts: Readonly<Record<keyof typeof NEON_TEST_SEED_COUNTS, number>>,
): NeonTestSeedPopulation {
  const entries = Object.entries(NEON_TEST_SEED_COUNTS) as readonly [
    keyof typeof NEON_TEST_SEED_COUNTS,
    number,
  ][];
  if (entries.every(([name]) => counts[name] === 0)) return "empty";
  if (entries.every(([name, expected]) => counts[name] === expected)) return "existing";
  throw new NeonTestSeedSafetyError("Neon seed found a partial fixed fixture.");
}

export function validateNeonTestRuntimeBoundary(
  observation: NeonTestRuntimeBoundaryObservation,
): void {
  if (
    !observation.identity.memberOfExpectedGroup ||
    !observation.identity.canReadCredentials ||
    observation.identity.canWriteBusinessData ||
    observation.identity.canRunDdl ||
    !observation.application.memberOfExpectedGroup ||
    !observation.application.canReadBusinessData ||
    !observation.application.canWriteBusinessData ||
    observation.application.canReadCredentials ||
    observation.application.canRunDdl
  ) {
    throw new NeonTestSeedSafetyError("Neon runtime database role boundary is inconsistent.");
  }
}

async function inspectSeedPopulation(client: Client): Promise<NeonTestSeedPopulation> {
  const counts = { ...Object.fromEntries(Object.keys(NEON_TEST_SEED_COUNTS).map((name) => [name, 0])) } as Record<
    keyof typeof NEON_TEST_SEED_COUNTS,
    number
  >;
  const allowed = seedTableRules();
  const tables = await client.query<{ tablename: string }>(`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
  `);
  for (const { tablename } of tables.rows) {
    const total = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM public.${quoteIdentifier(tablename)}`,
    );
    const totalCount = total.rows[0]?.count ?? 0;
    const rule = allowed.get(tablename);
    if (!rule) {
      if (totalCount !== 0) {
        throw new NeonTestSeedSafetyError("Neon seed found a non-seed business row.");
      }
      continue;
    }
    const seeded = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM public.${quoteIdentifier(tablename)} WHERE ${rule.predicate}`,
      [...rule.values],
    );
    const seededCount = seeded.rows[0]?.count ?? 0;
    if (seededCount !== totalCount) {
      throw new NeonTestSeedSafetyError("Neon seed found a business row outside the fixed UUID fixture.");
    }
    counts[rule.countName] = seededCount;
  }
  return classifyNeonTestSeedPopulation(counts);
}

async function lockSeedTables(client: Client): Promise<void> {
  const tables = [...seedTableRules().keys()].sort().map((table) => `public.${quoteIdentifier(table)}`);
  await client.query(`LOCK TABLE ${tables.join(", ")} IN SHARE ROW EXCLUSIVE MODE`);
}

function seedTableRules(): ReadonlyMap<
  string,
  Readonly<{
    countName: keyof typeof NEON_TEST_SEED_COUNTS;
    predicate: string;
    values: readonly unknown[];
  }>
> {
  return new Map([
    ["access_organizations", rule("organizations", "id = $1", [NEON_TEST_ORGANIZATION.id])],
    ["identity_users", rule("users", "id = ANY($1::uuid[])", [NEON_TEST_PRINCIPALS.map(({ userId }) => userId)])],
    ["access_organization_memberships", rule("memberships", "id = ANY($1::uuid[])", [NEON_TEST_PRINCIPALS.map(({ membershipId }) => membershipId)])],
    ["access_role_bindings", rule("role_bindings", "id = ANY($1::uuid[])", [NEON_TEST_PRINCIPALS.map(({ roleBindingId }) => roleBindingId)])],
    ["crm_students", rule("students", "id = ANY($1::uuid[])", [NEON_TEST_STUDENTS.map(({ id }) => id)])],
    ["crm_guardians", rule("guardians", "id = ANY($1::uuid[])", [NEON_TEST_STUDENTS.map(({ guardianId }) => guardianId)])],
    ["crm_student_guardian_relationships", rule("relationships", "id = ANY($1::uuid[])", [NEON_TEST_STUDENTS.map(({ relationshipId }) => relationshipId)])],
    ["cases_schema_manifests", rule("assessment_manifests", "id = $1", [NEON_TEST_MANIFEST_ID])],
    ["cases_schema_manifest_fields", rule("manifest_fields", "manifest_id = $1", [NEON_TEST_MANIFEST_ID])],
    ["schools_schools", rule("schools", "id = ANY($1::uuid[])", [NEON_TEST_SCHOOLS.map(({ id }) => id)])],
    ["schools_snapshots", rule("school_snapshots", "id = $1", [NEON_TEST_SCHOOL_SNAPSHOT_ID])],
    ["schools_snapshot_records", rule("school_records", "id = ANY($1::uuid[])", [NEON_TEST_SCHOOLS.map(({ recordId }) => recordId)])],
  ]);
}

function rule(
  countName: keyof typeof NEON_TEST_SEED_COUNTS,
  predicate: string,
  values: readonly unknown[],
) {
  return Object.freeze({ countName, predicate, values });
}

async function insertIdentityAndAccess(client: Client): Promise<void> {
  const founder = NEON_TEST_PRINCIPALS[0]!;
  for (const principal of NEON_TEST_PRINCIPALS) {
    await client.query(
      `INSERT INTO identity_users (id, normalized_email, status, created_by_user_id)
       VALUES ($1,$2,'active',$3)`,
      [principal.userId, principal.email, principal.role === "founder" ? null : founder.userId],
    );
  }
  await client.query(
    `INSERT INTO access_organizations (id, display_name, status, created_by_user_id)
     VALUES ($1,$2,$3,$4)`,
    [NEON_TEST_ORGANIZATION.id, NEON_TEST_ORGANIZATION.displayName,
      NEON_TEST_ORGANIZATION.status, founder.userId],
  );
  for (const principal of NEON_TEST_PRINCIPALS) {
    await client.query(
      `INSERT INTO access_organization_memberships
        (id, organization_id, user_id, status, created_by_user_id)
       VALUES ($1,$2,$3,'active',$4)`,
      [principal.membershipId, NEON_TEST_ORGANIZATION.id, principal.userId, founder.userId],
    );
    await client.query(
      `INSERT INTO access_role_bindings
        (id, organization_id, membership_id, user_id, role, status, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,'active',$6)`,
      [principal.roleBindingId, NEON_TEST_ORGANIZATION.id, principal.membershipId,
        principal.userId, principal.role, founder.userId],
    );
  }
}

async function insertStudentsAndGuardians(client: Client): Promise<void> {
  for (const student of NEON_TEST_STUDENTS) {
    await client.query(
      `INSERT INTO crm_students
        (id, organization_id, display_name, date_of_birth, contact_email, contact_phone, status)
       VALUES ($1,$2,$3,$4,$5,$6,'active')`,
      [student.id, NEON_TEST_ORGANIZATION.id, student.displayName, student.dateOfBirth,
        student.contactEmail, student.contactPhone],
    );
    await client.query(
      `INSERT INTO crm_guardians
        (id, organization_id, display_name, email, phone, status)
       VALUES ($1,$2,$3,$4,$5,'active')`,
      [student.guardianId, NEON_TEST_ORGANIZATION.id, student.guardianName,
        student.guardianEmail, student.guardianPhone],
    );
    await client.query(
      `INSERT INTO crm_student_guardian_relationships
        (id, organization_id, student_id, guardian_id, relationship_type,
         is_legal_guardian, is_primary_contact, is_emergency_contact,
         is_billing_contact, notification_consent, starts_at)
       VALUES ($1,$2,$3,$4,$5,true,true,true,false,true,transaction_timestamp())`,
      [student.relationshipId, NEON_TEST_ORGANIZATION.id, student.id,
        student.guardianId, student.relationshipType],
    );
  }
}

async function insertApprovedManifest(
  client: Client,
  fixture: NeonTestManifestFixture,
): Promise<void> {
  const founder = NEON_TEST_PRINCIPALS[0]!;
  const byLayer = fixture.modulesByLayer;
  await client.query(
    `INSERT INTO cases_schema_manifests
      (id, application_type, composition_version, base_module_id, base_module_version,
       education_stage_module_id, education_stage_module_version, school_system_module_id,
       school_system_module_version, admission_route_module_id, admission_route_module_version,
       content_sha256, status)
     VALUES ($1,'k12',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'candidate')`,
    [NEON_TEST_MANIFEST_ID, NEON_TEST_MANIFEST_COMPOSITION_VERSION,
      byLayer.get("base")!.moduleId, byLayer.get("base")!.version,
      byLayer.get("education_stage")!.moduleId, byLayer.get("education_stage")!.version,
      byLayer.get("school_system")!.moduleId, byLayer.get("school_system")!.version,
      byLayer.get("admission_route")!.moduleId, byLayer.get("admission_route")!.version,
      fixture.contentSha256],
  );
  for (const field of fixture.fields) {
    await client.query(
      `INSERT INTO cases_schema_manifest_fields
        (manifest_id, module_layer, module_id, module_version, field_id,
         value_type, visibility, blocking_stages)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
      [NEON_TEST_MANIFEST_ID, field.moduleLayer, field.moduleId, field.moduleVersion,
        field.fieldId, field.valueType, field.visibility, JSON.stringify(field.blockingStages)],
    );
  }
  await client.query(
    `UPDATE cases_schema_manifests
        SET status = 'approved', approved_by_user_id = $2,
            approved_at = transaction_timestamp(), updated_at = transaction_timestamp()
      WHERE id = $1 AND status = 'candidate'`,
    [NEON_TEST_MANIFEST_ID, founder.userId],
  );
}

async function insertSchools(client: Client): Promise<void> {
  for (const school of NEON_TEST_SCHOOLS) {
    await client.query(
      `INSERT INTO schools_schools (id, organization_id, source_school_key, record_version)
       VALUES ($1,$2,$3,1)`,
      [school.id, NEON_TEST_ORGANIZATION.id, school.sourceSchoolKey],
    );
  }
  await client.query(
    `INSERT INTO schools_snapshots
      (id, organization_id, source_release_id, manifest_sha256, file_set_json,
       status, record_count)
     VALUES ($1,$2,$3,$4,$5::jsonb,'active',$6)`,
    [NEON_TEST_SCHOOL_SNAPSHOT_ID, NEON_TEST_ORGANIZATION.id,
      NEON_TEST_SCHOOL_SOURCE_RELEASE_ID, neonTestSchoolSnapshotManifestSha256(),
      JSON.stringify({ kind: "env01_synthetic", source: "inline_seed", version: 1 }),
      NEON_TEST_SCHOOLS.length],
  );
  for (const school of NEON_TEST_SCHOOLS) {
    await client.query(
      `INSERT INTO schools_snapshot_records
        (id, organization_id, snapshot_id, school_id, source_school_key,
         fields_json, provenance_json, record_sha256)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)`,
      [school.recordId, NEON_TEST_ORGANIZATION.id, NEON_TEST_SCHOOL_SNAPSHOT_ID,
        school.id, school.sourceSchoolKey, JSON.stringify(school.fields),
        JSON.stringify(school.provenance), school.recordSha256],
    );
  }
}

async function assertExactSeedContent(
  client: Client,
  fixture: NeonTestManifestFixture,
): Promise<void> {
  if ((await inspectSeedPopulation(client)) !== "existing") {
    throw new NeonTestSeedSafetyError("Neon synthetic seed counts are inconsistent.");
  }

  const founder = NEON_TEST_PRINCIPALS[0]!;
  for (const principal of NEON_TEST_PRINCIPALS) {
    await assertExactRow(client, `
      SELECT count(*)::int AS count
        FROM identity_users
       WHERE id = $1
         AND normalized_email = $2
         AND status = 'active'
         AND session_version = 1
         AND record_version = 1
         AND created_by_user_id IS NOT DISTINCT FROM $3::uuid
    `, [principal.userId, principal.email, principal.role === "founder" ? null : founder.userId]);
  }

  await assertExactRow(client, `
    SELECT count(*)::int AS count
      FROM access_organizations
     WHERE id = $1 AND display_name = $2 AND status = 'active'
       AND record_version = 1 AND created_by_user_id = $3
  `, [NEON_TEST_ORGANIZATION.id, NEON_TEST_ORGANIZATION.displayName, founder.userId]);

  for (const principal of NEON_TEST_PRINCIPALS) {
    await assertExactRow(client, `
      SELECT count(*)::int AS count
        FROM access_organization_memberships
       WHERE id = $1 AND organization_id = $2 AND user_id = $3
         AND status = 'active' AND record_version = 1 AND created_by_user_id = $4
    `, [principal.membershipId, NEON_TEST_ORGANIZATION.id, principal.userId, founder.userId]);
    await assertExactRow(client, `
      SELECT count(*)::int AS count
        FROM access_role_bindings
       WHERE id = $1 AND organization_id = $2 AND membership_id = $3
         AND user_id = $4 AND role = $5 AND status = 'active'
         AND record_version = 1 AND created_by_user_id = $6
    `, [principal.roleBindingId, NEON_TEST_ORGANIZATION.id, principal.membershipId,
      principal.userId, principal.role, founder.userId]);
  }

  for (const student of NEON_TEST_STUDENTS) {
    await assertExactRow(client, `
      SELECT count(*)::int AS count
        FROM crm_students
       WHERE id = $1 AND organization_id = $2 AND display_name = $3
         AND date_of_birth = $4::date AND contact_email IS NOT DISTINCT FROM $5::text
         AND contact_phone IS NOT DISTINCT FROM $6::text AND status = 'active'
         AND deletion_requested_at IS NULL AND deletion_requested_by_user_id IS NULL
         AND deletion_reason IS NULL AND purge_approved_at IS NULL
         AND purge_approved_by_user_id IS NULL AND purged_at IS NULL
         AND record_version = 1
    `, [student.id, NEON_TEST_ORGANIZATION.id, student.displayName, student.dateOfBirth,
      student.contactEmail, student.contactPhone]);
    await assertExactRow(client, `
      SELECT count(*)::int AS count
        FROM crm_guardians
       WHERE id = $1 AND organization_id = $2 AND display_name = $3
         AND email IS NOT DISTINCT FROM $4::text AND phone IS NOT DISTINCT FROM $5::text
         AND status = 'active' AND deletion_requested_at IS NULL
         AND deletion_requested_by_user_id IS NULL AND deletion_reason IS NULL
         AND purge_approved_at IS NULL AND purge_approved_by_user_id IS NULL
         AND purged_at IS NULL AND record_version = 1
    `, [student.guardianId, NEON_TEST_ORGANIZATION.id, student.guardianName,
      student.guardianEmail, student.guardianPhone]);
    await assertExactRow(client, `
      SELECT count(*)::int AS count
        FROM crm_student_guardian_relationships
       WHERE id = $1 AND organization_id = $2 AND student_id = $3 AND guardian_id = $4
         AND relationship_type = $5 AND is_legal_guardian AND is_primary_contact
         AND is_emergency_contact AND NOT is_billing_contact AND notification_consent
         AND starts_at IS NOT NULL AND ends_at IS NULL AND ended_by_user_id IS NULL
         AND end_reason IS NULL AND record_version = 1
    `, [student.relationshipId, NEON_TEST_ORGANIZATION.id, student.id,
      student.guardianId, student.relationshipType]);
  }

  const byLayer = fixture.modulesByLayer;
  await assertExactRow(client, `
    SELECT count(*)::int AS count
      FROM cases_schema_manifests
     WHERE id = $1 AND application_type = 'k12' AND composition_version = $2
       AND base_module_id = $3 AND base_module_version = $4
       AND education_stage_module_id = $5 AND education_stage_module_version = $6
       AND school_system_module_id = $7 AND school_system_module_version = $8
       AND admission_route_module_id = $9 AND admission_route_module_version = $10
       AND content_sha256 = $11 AND status = 'approved'
       AND approved_by_user_id = $12 AND approved_at IS NOT NULL
       AND retired_by_user_id IS NULL AND retired_at IS NULL AND retirement_reason IS NULL
  `, [NEON_TEST_MANIFEST_ID, NEON_TEST_MANIFEST_COMPOSITION_VERSION,
    byLayer.get("base")!.moduleId, byLayer.get("base")!.version,
    byLayer.get("education_stage")!.moduleId, byLayer.get("education_stage")!.version,
    byLayer.get("school_system")!.moduleId, byLayer.get("school_system")!.version,
    byLayer.get("admission_route")!.moduleId, byLayer.get("admission_route")!.version,
    fixture.contentSha256, founder.userId]);
  for (const field of fixture.fields) {
    await assertExactRow(client, `
      SELECT count(*)::int AS count
        FROM cases_schema_manifest_fields
       WHERE manifest_id = $1 AND module_layer = $2 AND module_id = $3
         AND module_version = $4 AND field_id = $5 AND value_type = $6
         AND visibility = $7 AND blocking_stages = $8::jsonb
    `, [NEON_TEST_MANIFEST_ID, field.moduleLayer, field.moduleId, field.moduleVersion,
      field.fieldId, field.valueType, field.visibility, JSON.stringify(field.blockingStages)]);
  }

  for (const school of NEON_TEST_SCHOOLS) {
    await assertExactRow(client, `
      SELECT count(*)::int AS count
        FROM schools_schools
       WHERE id = $1 AND organization_id = $2 AND source_school_key = $3
         AND record_version = 1
    `, [school.id, NEON_TEST_ORGANIZATION.id, school.sourceSchoolKey]);
  }
  const snapshotFileSet = { kind: "env01_synthetic", source: "inline_seed", version: 1 };
  await assertExactRow(client, `
    SELECT count(*)::int AS count
      FROM schools_snapshots
     WHERE id = $1 AND organization_id = $2 AND source_release_id = $3
       AND manifest_sha256 = $4 AND file_set_json = $5::jsonb
       AND file_set_json->>'kind' = 'env01_synthetic'
       AND status = 'active' AND record_count = $6
  `, [NEON_TEST_SCHOOL_SNAPSHOT_ID, NEON_TEST_ORGANIZATION.id,
    NEON_TEST_SCHOOL_SOURCE_RELEASE_ID, neonTestSchoolSnapshotManifestSha256(),
    JSON.stringify(snapshotFileSet), NEON_TEST_SCHOOLS.length]);
  for (const school of NEON_TEST_SCHOOLS) {
    await assertExactRow(client, `
      SELECT count(*)::int AS count
        FROM schools_snapshot_records
       WHERE id = $1 AND organization_id = $2 AND snapshot_id = $3 AND school_id = $4
         AND source_school_key = $5 AND fields_json = $6::jsonb
         AND provenance_json = $7::jsonb AND record_sha256 = $8
    `, [school.recordId, NEON_TEST_ORGANIZATION.id, NEON_TEST_SCHOOL_SNAPSHOT_ID,
      school.id, school.sourceSchoolKey, JSON.stringify(school.fields),
      JSON.stringify(school.provenance), school.recordSha256]);
  }

  for (const table of PROHIBITED_SEED_TABLES) {
    const prohibited = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM public.${quoteIdentifier(table)}`,
    );
    if (prohibited.rows[0]?.count !== 0) {
      throw new NeonTestSeedSafetyError("Neon seed created a prohibited runtime or evidence row.");
    }
  }
}

async function assertExactRow(
  client: Client,
  query: string,
  values: unknown[],
): Promise<void> {
  const result = await client.query<{ count: number }>(query, values);
  if (result.rows[0]?.count !== 1) {
    throw new NeonTestSeedSafetyError("Neon fixed seed content or hash is inconsistent.");
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function redactError(error: unknown, environment: RuntimeEnvironment): string {
  let message = error instanceof Error ? error.message : "Neon seed failed.";
  const url = environment.TEST_MIGRATION_DATABASE_URL?.trim();
  const secrets = new Set<string>();
  for (const name of REDACTED_ENVIRONMENT_VARIABLES) {
    const value = environment[name]?.trim();
    if (value) secrets.add(value);
  }
  if (url) {
    try {
      const parsed = new URL(url);
      secrets.add(parsed.hostname);
      secrets.add(decodeURIComponent(parsed.password));
    } catch {
      // The raw invalid value is already included above.
    }
  }
  for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) {
    message = message.replaceAll(secret, "[redacted]");
  }
  return message;
}

async function runCli(
  arguments_: readonly string[],
  environment: RuntimeEnvironment,
): Promise<void> {
  const mode = readNeonTestSeedMode(arguments_);
  const evidence = await seedNeonTestRelease1(readNeonTestSeedTarget(environment), mode);
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}

const isMainModule =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  runCli(process.argv.slice(2), process.env).catch((error: unknown) => {
    process.stderr.write(`${redactError(error, process.env)}\n`);
    process.exitCode = 1;
  });
}
