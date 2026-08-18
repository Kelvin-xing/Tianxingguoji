import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { Client } from "pg";

import {
  composeK12Manifest,
  parseK12Module,
  type K12Module,
} from "../../modules/cases/public.ts";
import {
  LOCAL_SYNTHETIC_ORGANIZATION,
  getLocalSyntheticPrincipal,
} from "../../modules/identity/server.ts";
import { sha256SchoolValue } from "../../modules/schools/public.ts";
import { loadLocalSyntheticConfig } from "../../lib/runtime/local-synthetic-config.ts";
import { readLocalMigrationTarget } from "./run-local-migrations.ts";

const LOCAL_APPLICATION_PASSWORD = "tianxing-local-app-only";
const MANIFEST_ID = "30000000-0000-4000-8000-000000000002";
const MANIFEST_COMPOSITION_VERSION = "local-release1-v2";
const SCHOOL_SNAPSHOT_ID = "40000000-0000-4000-8000-000000000001";
const SCHOOL_SOURCE_RELEASE_ID = "local-release1-synthetic-schools-v1";
const MODULE_FILES = Object.freeze([
  "schema/k12/student-profile.v1.json",
  "schema/k12/education-profile.v1.json",
  "schema/k12/school-preferences.v1.json",
  "schema/k12/family-context.v1.json",
]);
const STUDENTS = Object.freeze([
  Object.freeze({
    id: "20000000-0000-4000-8000-000000000101",
    displayName: "Local Student A",
    dateOfBirth: "2014-03-12",
    contactEmail: "student-a@local.invalid",
    contactPhone: "+852 5555 0101",
    guardianId: "20000000-0000-4000-8000-000000000201",
    guardianName: "Local Guardian A",
    guardianEmail: "guardian-a@local.invalid",
    guardianPhone: "+852 5555 0201",
    relationshipId: "20000000-0000-4000-8000-000000000301",
    relationshipType: "parent",
  }),
  Object.freeze({
    id: "20000000-0000-4000-8000-000000000102",
    displayName: "Local Student B",
    dateOfBirth: "2012-09-21",
    contactEmail: null,
    contactPhone: null,
    guardianId: "20000000-0000-4000-8000-000000000202",
    guardianName: "Local Guardian B",
    guardianEmail: "guardian-b@local.invalid",
    guardianPhone: "+852 5555 0202",
    relationshipId: "20000000-0000-4000-8000-000000000302",
    relationshipType: "parent",
  }),
]);

export const LOCAL_RELEASE1_SCHOOLS = Object.freeze([
  schoolSeed("40000000-0000-4000-8000-000000000101", "40000000-0000-4000-8000-000000000201",
    "synthetic-school-001", "本地合成学校一", "Local Synthetic School One", "Central"),
  schoolSeed("40000000-0000-4000-8000-000000000102", "40000000-0000-4000-8000-000000000202",
    "synthetic-school-002", "本地合成学校二", "Local Synthetic School Two", "Eastern"),
  schoolSeed("40000000-0000-4000-8000-000000000103", "40000000-0000-4000-8000-000000000203",
    "synthetic-school-003", "本地合成学校三", "Local Synthetic School Three", "Kowloon"),
]);

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

export interface LocalRelease1SeedTarget {
  readonly ownerConnectionString: string;
  readonly runtimeConnectionString: string;
}

export class LocalRelease1SeedSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalRelease1SeedSafetyError";
  }
}

export function readLocalRelease1SeedTarget(
  environment: RuntimeEnvironment = process.env,
): LocalRelease1SeedTarget {
  const owner = readLocalMigrationTarget(environment);
  const runtime = loadLocalSyntheticConfig(environment).database.applicationConnectionString;
  const runtimeUrl = new URL(runtime);
  if (
    runtimeUrl.username !== "tianxing_app" ||
    runtimeUrl.password !== LOCAL_APPLICATION_PASSWORD ||
    runtimeUrl.host !== `${owner.host}:${owner.port}` ||
    runtimeUrl.pathname !== `/${owner.database}`
  ) {
    throw new LocalRelease1SeedSafetyError(
      "Local Release 1 seed requires the fixed loopback application target.",
    );
  }
  return Object.freeze({
    ownerConnectionString: owner.connectionString,
    runtimeConnectionString: runtime,
  });
}

export async function seedLocalRelease1(
  target: LocalRelease1SeedTarget,
): Promise<Readonly<{
  students: number;
  guardians: number;
  relationships: number;
  manifests: number;
  fields: number;
  schools: number;
  schoolSnapshots: number;
  schoolRecords: number;
}>> {
  const modules = await loadSchemaModules();
  const owner = new Client({
    connectionString: target.ownerConnectionString,
    application_name: "tianxing-local-release1-seed",
    connectionTimeoutMillis: 3_000,
    query_timeout: 5_000,
    ssl: false,
  });
  await owner.connect();
  try {
    await assertOwnerConnection(owner);
    await owner.query("BEGIN");
    try {
      await provisionApplicationRole(owner);
      await seedStudentsAndGuardians(owner);
      await seedManifest(owner, modules);
      await seedSchools(owner);
      const counts = await verifySeed(owner, modules);
      await owner.query("COMMIT");
      await verifyRuntimeBoundary(target.runtimeConnectionString);
      return counts;
    } catch (error) {
      await owner.query("ROLLBACK");
      throw error;
    }
  } finally {
    await owner.end();
  }
}

async function loadSchemaModules(): Promise<readonly K12Module[]> {
  const modules = await Promise.all(MODULE_FILES.map(async (path) => {
    const parsed = parseK12Module(JSON.parse(await readFile(path, "utf8")));
    if (parsed.catalogueStatus !== "approved" || parsed.productionEnabled !== true) {
      throw new LocalRelease1SeedSafetyError(`Schema module is not approved: ${path}`);
    }
    return parsed;
  }));
  const layers = modules.map(({ layer }) => layer).sort();
  if (layers.join(",") !== "admission_route,base,education_stage,school_system") {
    throw new LocalRelease1SeedSafetyError("Release 1 manifest requires exactly four schema layers.");
  }
  return Object.freeze(modules);
}

async function assertOwnerConnection(client: Client): Promise<void> {
  const result = await client.query<{ database_name: string; user_name: string; rolsuper: boolean }>(
    `SELECT current_database() AS database_name, current_user AS user_name, role.rolsuper
       FROM pg_roles AS role WHERE role.rolname = current_user`,
  );
  const row = result.rows[0];
  if (row?.database_name !== "tianxing" || row.user_name !== "tianxing_migration" || !row.rolsuper) {
    throw new LocalRelease1SeedSafetyError("Connected database identity is not the local owner.");
  }
}

async function provisionApplicationRole(client: Client): Promise<void> {
  await client.query(
    `ALTER ROLE tianxing_app WITH
       LOGIN PASSWORD 'tianxing-local-app-only'
       NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
  );
}

async function seedStudentsAndGuardians(client: Client): Promise<void> {
  for (const student of STUDENTS) {
    await client.query(
      `INSERT INTO crm_students
        (id, organization_id, display_name, date_of_birth, contact_email, contact_phone, status)
       VALUES ($1,$2,$3,$4,$5,$6,'active') ON CONFLICT (id) DO NOTHING`,
      [student.id, LOCAL_SYNTHETIC_ORGANIZATION.id, student.displayName,
        student.dateOfBirth, student.contactEmail, student.contactPhone],
    );
    await client.query(
      `INSERT INTO crm_guardians
        (id, organization_id, display_name, email, phone, status)
       VALUES ($1,$2,$3,$4,$5,'active') ON CONFLICT (id) DO NOTHING`,
      [student.guardianId, LOCAL_SYNTHETIC_ORGANIZATION.id, student.guardianName,
        student.guardianEmail, student.guardianPhone],
    );
    await client.query(
      `INSERT INTO crm_student_guardian_relationships
        (id, organization_id, student_id, guardian_id, relationship_type,
         is_legal_guardian, is_primary_contact, is_emergency_contact,
         is_billing_contact, notification_consent, starts_at)
       VALUES ($1,$2,$3,$4,$5,true,true,true,true,true,transaction_timestamp())
       ON CONFLICT (id) DO NOTHING`,
      [student.relationshipId, LOCAL_SYNTHETIC_ORGANIZATION.id, student.id,
        student.guardianId, student.relationshipType],
    );
  }
}

async function seedManifest(client: Client, modules: readonly K12Module[]): Promise<void> {
  const byLayer = new Map(modules.map((module) => [module.layer, module]));
  const hash = composeK12Manifest(modules).contentSha256;
  const founder = getLocalSyntheticPrincipal("founder");
  const existing = await client.query<{ status: string }>(
    "SELECT status FROM cases_schema_manifests WHERE id = $1",
    [MANIFEST_ID],
  );
  if (existing.rows[0]) {
    if (existing.rows[0].status !== "approved") {
      throw new LocalRelease1SeedSafetyError("Existing local manifest is not approved.");
    }
    return;
  }
  await client.query(
    `INSERT INTO cases_schema_manifests
      (id, application_type, composition_version, base_module_id, base_module_version,
       education_stage_module_id, education_stage_module_version, school_system_module_id,
       school_system_module_version, admission_route_module_id, admission_route_module_version,
       content_sha256, status)
     VALUES ($1,'k12',$11,$2,$3,$4,$5,$6,$7,$8,$9,$10,'candidate')`,
    [MANIFEST_ID, byLayer.get("base")!.moduleId, byLayer.get("base")!.version,
      byLayer.get("education_stage")!.moduleId, byLayer.get("education_stage")!.version,
      byLayer.get("school_system")!.moduleId, byLayer.get("school_system")!.version,
      byLayer.get("admission_route")!.moduleId, byLayer.get("admission_route")!.version,
      hash, MANIFEST_COMPOSITION_VERSION],
  );
  for (const module of modules) {
    for (const field of module.fields) {
      await client.query(
        `INSERT INTO cases_schema_manifest_fields
          (manifest_id, module_layer, module_id, module_version, field_id,
           value_type, visibility, blocking_stages)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
         ON CONFLICT (manifest_id, module_layer, module_id, module_version, field_id) DO NOTHING`,
        [MANIFEST_ID, module.layer, module.moduleId, module.version, field.fieldId,
          field.valueType, field.visibility,
          JSON.stringify(field.blockingStages.map(toStoredBlockerStage))],
      );
    }
  }
  await client.query(
    `UPDATE cases_schema_manifests
        SET status = 'approved', approved_by_user_id = $2,
            approved_at = transaction_timestamp(), updated_at = transaction_timestamp()
      WHERE id = $1 AND status = 'candidate'`,
    [MANIFEST_ID, founder.userId],
  );
}

async function seedSchools(client: Client): Promise<void> {
  const active = await client.query<{ id: string }>(
    `SELECT id FROM schools_snapshots
      WHERE organization_id = $1 AND status = 'active'`,
    [LOCAL_SYNTHETIC_ORGANIZATION.id],
  );
  if (active.rows[0] && active.rows[0].id !== SCHOOL_SNAPSHOT_ID) {
    throw new LocalRelease1SeedSafetyError("Another active school snapshot already exists.");
  }

  for (const school of LOCAL_RELEASE1_SCHOOLS) {
    await client.query(
      `INSERT INTO schools_schools
        (id, organization_id, source_school_key, record_version)
       VALUES ($1,$2,$3,1) ON CONFLICT (id) DO NOTHING`,
      [school.id, LOCAL_SYNTHETIC_ORGANIZATION.id, school.sourceSchoolKey],
    );
  }
  const manifestSha256 = schoolSnapshotManifestSha256();
  const fileSet = Object.freeze({
    kind: "local_synthetic",
    source: "inline_seed",
    version: 1,
  });
  await client.query(
    `INSERT INTO schools_snapshots
      (id, organization_id, source_release_id, manifest_sha256, file_set_json,
       status, record_count)
     VALUES ($1,$2,$3,$4,$5::jsonb,'active',$6)
     ON CONFLICT (id) DO NOTHING`,
    [SCHOOL_SNAPSHOT_ID, LOCAL_SYNTHETIC_ORGANIZATION.id, SCHOOL_SOURCE_RELEASE_ID,
      manifestSha256, JSON.stringify(fileSet), LOCAL_RELEASE1_SCHOOLS.length],
  );
  for (const school of LOCAL_RELEASE1_SCHOOLS) {
    await client.query(
      `INSERT INTO schools_snapshot_records
        (id, organization_id, snapshot_id, school_id, source_school_key,
         fields_json, provenance_json, record_sha256)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)
       ON CONFLICT (id) DO NOTHING`,
      [school.recordId, LOCAL_SYNTHETIC_ORGANIZATION.id, SCHOOL_SNAPSHOT_ID,
        school.id, school.sourceSchoolKey, JSON.stringify(school.fields),
        JSON.stringify(school.provenance), school.recordSha256],
    );
  }
  await verifySchoolSeedContent(client, manifestSha256, fileSet);
}

async function verifySchoolSeedContent(
  client: Client,
  manifestSha256: string,
  fileSet: Readonly<Record<string, string | number>>,
): Promise<void> {
  const snapshot = await client.query<{
    source_release_id: string;
    manifest_sha256: string;
    file_set_json: unknown;
    status: string;
    record_count: number;
  }>(
    `SELECT source_release_id, manifest_sha256, file_set_json, status, record_count
       FROM schools_snapshots WHERE id = $1 AND organization_id = $2`,
    [SCHOOL_SNAPSHOT_ID, LOCAL_SYNTHETIC_ORGANIZATION.id],
  );
  const storedSnapshot = snapshot.rows[0];
  if (!storedSnapshot || storedSnapshot.source_release_id !== SCHOOL_SOURCE_RELEASE_ID ||
      storedSnapshot.manifest_sha256 !== manifestSha256 || storedSnapshot.status !== "active" ||
      storedSnapshot.record_count !== LOCAL_RELEASE1_SCHOOLS.length ||
      sha256SchoolValue(storedSnapshot.file_set_json) !== sha256SchoolValue(fileSet)) {
    throw new LocalRelease1SeedSafetyError("Local school snapshot is inconsistent.");
  }
  for (const school of LOCAL_RELEASE1_SCHOOLS) {
    const stored = await client.query<{
      school_source_school_key: string;
      record_source_school_key: string;
      fields_json: unknown;
      provenance_json: unknown;
      record_sha256: string;
    }>(
      `SELECT school.source_school_key AS school_source_school_key,
              record.source_school_key AS record_source_school_key, record.fields_json,
              record.provenance_json, record.record_sha256
         FROM schools_schools AS school
         JOIN schools_snapshot_records AS record
           ON record.school_id = school.id AND record.organization_id = school.organization_id
        WHERE school.id = $1 AND school.organization_id = $2
          AND record.id = $3 AND record.snapshot_id = $4`,
      [school.id, LOCAL_SYNTHETIC_ORGANIZATION.id, school.recordId, SCHOOL_SNAPSHOT_ID],
    );
    const row = stored.rows[0];
    if (!row || row.school_source_school_key !== school.sourceSchoolKey ||
        row.record_source_school_key !== school.sourceSchoolKey ||
        row.record_sha256 !== school.recordSha256 ||
        sha256SchoolValue(row.fields_json) !== sha256SchoolValue(school.fields) ||
        sha256SchoolValue(row.provenance_json) !== sha256SchoolValue(school.provenance)) {
      throw new LocalRelease1SeedSafetyError(`Local synthetic school is inconsistent: ${school.id}`);
    }
  }
}

async function verifySeed(client: Client, modules: readonly K12Module[]) {
  const expectedFields = modules.reduce((total, module) => total + module.fields.length, 0);
  const result = await client.query<{
    students: number;
    guardians: number;
    relationships: number;
    manifests: number;
    fields: number;
    schools: number;
    school_snapshots: number;
    school_records: number;
  }>(
    `SELECT
       (SELECT count(*)::int FROM crm_students WHERE id = ANY($1::uuid[])) AS students,
       (SELECT count(*)::int FROM crm_guardians WHERE id = ANY($2::uuid[])) AS guardians,
       (SELECT count(*)::int FROM crm_student_guardian_relationships WHERE id = ANY($3::uuid[])) AS relationships,
       (SELECT count(*)::int FROM cases_schema_manifests WHERE id = $4 AND status = 'approved') AS manifests,
       (SELECT count(*)::int FROM cases_schema_manifest_fields WHERE manifest_id = $4) AS fields,
       (SELECT count(*)::int FROM schools_schools WHERE id = ANY($5::uuid[])) AS schools,
       (SELECT count(*)::int FROM schools_snapshots
         WHERE id = $6 AND status = 'active') AS school_snapshots,
       (SELECT count(*)::int FROM schools_snapshot_records
         WHERE snapshot_id = $6 AND id = ANY($7::uuid[])) AS school_records`,
    [STUDENTS.map(({ id }) => id), STUDENTS.map(({ guardianId }) => guardianId),
      STUDENTS.map(({ relationshipId }) => relationshipId), MANIFEST_ID,
      LOCAL_RELEASE1_SCHOOLS.map(({ id }) => id), SCHOOL_SNAPSHOT_ID,
      LOCAL_RELEASE1_SCHOOLS.map(({ recordId }) => recordId)],
  );
  const counts = result.rows[0];
  if (!counts || counts.students !== STUDENTS.length || counts.guardians !== STUDENTS.length ||
      counts.relationships !== STUDENTS.length || counts.manifests !== 1 ||
      counts.fields !== expectedFields || counts.schools !== LOCAL_RELEASE1_SCHOOLS.length ||
      counts.school_snapshots !== 1 || counts.school_records !== LOCAL_RELEASE1_SCHOOLS.length) {
    throw new LocalRelease1SeedSafetyError("Local Release 1 seed is inconsistent.");
  }
  return Object.freeze({
    students: counts.students,
    guardians: counts.guardians,
    relationships: counts.relationships,
    manifests: counts.manifests,
    fields: counts.fields,
    schools: counts.schools,
    schoolSnapshots: counts.school_snapshots,
    schoolRecords: counts.school_records,
  });
}

async function verifyRuntimeBoundary(connectionString: string): Promise<void> {
  const runtime = new Client({
    connectionString,
    application_name: "tianxing-local-release1-verifier",
    connectionTimeoutMillis: 3_000,
    query_timeout: 5_000,
    ssl: false,
  });
  await runtime.connect();
  try {
    await runtime.query("BEGIN");
    await runtime.query("SELECT set_config('app.organization_id', $1, true)", [
      LOCAL_SYNTHETIC_ORGANIZATION.id,
    ]);
    await runtime.query("SELECT set_config('app.actor_user_id', $1, true)", [
      getLocalSyntheticPrincipal("founder").userId,
    ]);
    const visible = await runtime.query<{ students: number; manifests: number; schools: number }>(
      `SELECT
         (SELECT count(*)::int
            FROM crm_students
           WHERE id = ANY($1::uuid[])
             AND status = 'active') AS students,
         (SELECT count(*)::int FROM cases_list_approved_manifests() WHERE id = $2) AS manifests,
         (SELECT count(*)::int FROM schools_snapshot_records
           WHERE snapshot_id = $3 AND school_id = ANY($4::uuid[])) AS schools`,
      [STUDENTS.map(({ id }) => id), MANIFEST_ID, SCHOOL_SNAPSHOT_ID,
        LOCAL_RELEASE1_SCHOOLS.map(({ id }) => id)],
    );
    await runtime.query("ROLLBACK");
    if (visible.rows[0]?.students !== STUDENTS.length || visible.rows[0]?.manifests !== 1 ||
        visible.rows[0]?.schools !== LOCAL_RELEASE1_SCHOOLS.length) {
      throw new LocalRelease1SeedSafetyError("Local application runtime boundary is inconsistent.");
    }
  } finally {
    await runtime.end();
  }
}

function schoolSeed(
  id: string,
  recordId: string,
  sourceSchoolKey: string,
  schoolNameZh: string,
  schoolNameEn: string,
  district: string,
) {
  const fields = Object.freeze({
    school_key: sourceSchoolKey,
    school_name_zh: schoolNameZh,
    school_name_en: schoolNameEn,
    district,
    official_website: `https://${sourceSchoolKey}.local.invalid`,
  });
  const provenance = Object.freeze(Object.fromEntries(Object.keys(fields).map((fieldName) => [
    fieldName,
    Object.freeze({ source_kind: "synthetic_seed", source_release_id: SCHOOL_SOURCE_RELEASE_ID }),
  ])));
  return Object.freeze({
    id,
    recordId,
    sourceSchoolKey,
    fields,
    provenance,
    recordSha256: sha256SchoolValue({ sourceSchoolKey, fields, provenance }),
  });
}

function schoolSnapshotManifestSha256(): string {
  return sha256SchoolValue({
    sourceReleaseId: SCHOOL_SOURCE_RELEASE_ID,
    schools: LOCAL_RELEASE1_SCHOOLS.map((school) => ({
      id: school.id,
      sourceSchoolKey: school.sourceSchoolKey,
      recordSha256: school.recordSha256,
    })),
  });
}

function toStoredBlockerStage(stage: string): string {
  if (stage === "background_collection") return "background_complete";
  if (stage === "school_selection_confirmed") return "selection_ready";
  throw new LocalRelease1SeedSafetyError(`Unsupported K12 blocker stage: ${stage}`);
}

async function runCli(environment: RuntimeEnvironment): Promise<void> {
  const result = await seedLocalRelease1(readLocalRelease1SeedTarget(environment));
  process.stdout.write(`${JSON.stringify({ ...result, status: "pass" }, null, 2)}\n`);
}

const isMainModule =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  runCli(process.env).catch((error: unknown) => {
    const unsafeMessage = error instanceof Error ? error.message : "Unknown local Release 1 seed failure.";
    const secrets = [
      process.env.MIGRATION_DATABASE_URL ?? "",
      process.env.LOCAL_SYNTHETIC_APPLICATION_DATABASE_URL ?? "",
    ].filter(Boolean);
    process.stderr.write(`${secrets.reduce((message, secret) => message.replaceAll(secret, "[redacted]"), unsafeMessage)}\n`);
    process.exitCode = 1;
  });
}
