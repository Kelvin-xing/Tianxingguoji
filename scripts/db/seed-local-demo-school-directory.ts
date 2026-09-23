import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { Client } from "pg";

import {
  LOCAL_SYNTHETIC_ORGANIZATION,
  getLocalSyntheticPrincipal,
} from "../../modules/identity/server.ts";
import { sha256SchoolValue } from "../../modules/schools/public.ts";
import {
  readRelease1SyntheticSeedTarget,
  seedNeonTestRelease1,
} from "./seed-neon-test-release1.ts";
import type { OneRoleBaselineTarget } from "./run-one-role-baseline.ts";

const FIXTURE_PATH = "fixtures/local-demo/hk-school-directory.local-demo.seed.json";
const SNAPSHOT_ID = "40000000-0000-4000-8000-000000000701";
const SOURCE_RELEASE_ID = "local-demo-real-school-directory-v1";
const EXPECTED_RECORD_COUNT = 585;
const EXPECTED_SCHEMA = "local-demo-school-directory-v1";

type FixtureRecord = Readonly<Record<string, string | null>>;
type Fixture = Readonly<{
  schema_version: string;
  kind: string;
  demo_only: boolean;
  source: Readonly<{
    repository: string;
    commit_sha: string;
    input_path: string;
    exported_at: string;
    export_script: string;
  }>;
  record_count: number;
  directory_fields: readonly string[];
  records: readonly FixtureRecord[];
}>;

export class LocalDemoSchoolSeedSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalDemoSchoolSeedSafetyError";
  }
}

export async function seedLocalDemoSchoolDirectory(
  target: OneRoleBaselineTarget,
): Promise<Readonly<Record<string, unknown>>> {
  const fixture = await loadFixture();
  const fixtureBytes = await readFile(resolve(FIXTURE_PATH));
  const fixtureSha256 = sha256(fixtureBytes);
  const sourceRelease = `${SOURCE_RELEASE_ID}:${fixture.source.commit_sha.slice(0, 12)}`;

  const existing = await inspectExistingSchoolState(target.connectionString);
  if (existing.snapshotId === SNAPSHOT_ID && existing.sourceReleaseId === sourceRelease &&
      existing.recordCount === EXPECTED_RECORD_COUNT) {
    return evidence(fixture, fixtureSha256, sourceRelease, existing.recordCount, "existing");
  }
  if (existing.schoolCount !== 0 || existing.snapshotCount !== 0 || existing.recordCount !== 0) {
    throw new LocalDemoSchoolSeedSafetyError(
      "Local demo school seed requires an empty school directory; existing snapshots are immutable.",
    );
  }

  await seedNeonTestRelease1(target, "apply", { includeSchools: false });

  const owner = new Client({
    connectionString: target.connectionString,
    application_name: "tianxing-local-demo-school-directory-seed",
    connectionTimeoutMillis: 3_000,
    query_timeout: 10_000,
    ssl: false,
  });
  await owner.connect();
  try {
    await owner.query("BEGIN");
    await owner.query("SELECT set_config('app.organization_id', $1, true)", [
      LOCAL_SYNTHETIC_ORGANIZATION.id,
    ]);
    await owner.query("SELECT set_config('app.actor_user_id', $1, true)", [
      getLocalSyntheticPrincipal("founder").userId,
    ]);
    await assertNoSchoolRows(owner);
    const manifestSha256 = sha256SchoolValue({
      sourceRelease,
      fixtureSha256,
      records: fixture.records.map((record) => record.school_key),
    });
    const fileSet = {
      kind: "local_demo_school_directory",
      demo_only: true,
      fixture_path: FIXTURE_PATH,
      fixture_sha256: fixtureSha256,
      source: fixture.source,
    };
    await owner.query(
      `INSERT INTO schools_snapshots
        (id, organization_id, source_release_id, manifest_sha256, file_set_json,
         status, record_count)
       VALUES ($1,$2,$3,$4,$5::jsonb,'active',$6)`,
      [SNAPSHOT_ID, LOCAL_SYNTHETIC_ORGANIZATION.id, sourceRelease,
        manifestSha256, JSON.stringify(fileSet), fixture.records.length],
    );
    for (const record of fixture.records) {
      const schoolId = deterministicUuid(`${sourceRelease}:${record.school_key}:school`);
      const recordId = deterministicUuid(`${sourceRelease}:${record.school_key}:record`);
      const fields = Object.freeze({ ...record });
      const provenance = Object.freeze(Object.fromEntries(
        Object.entries(fields).map(([fieldName, value]) => [fieldName, Object.freeze({
          source_kind: "crawler_snapshot",
          source_snapshot_id: SNAPSHOT_ID,
          source_school_key: record.school_key,
          value_sha256: sha256SchoolValue(value),
        })]),
      ));
      const recordSha256 = sha256SchoolValue({ sourceSchoolKey: record.school_key, fields, provenance });
      await owner.query(
        `INSERT INTO schools_schools (id, organization_id, source_school_key, record_version)
         VALUES ($1,$2,$3,1)`,
        [schoolId, LOCAL_SYNTHETIC_ORGANIZATION.id, record.school_key],
      );
      await owner.query(
        `INSERT INTO schools_snapshot_records
          (id, organization_id, snapshot_id, school_id, source_school_key,
           fields_json, provenance_json, record_sha256)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)`,
        [recordId, LOCAL_SYNTHETIC_ORGANIZATION.id, SNAPSHOT_ID, schoolId,
          record.school_key, JSON.stringify(fields), JSON.stringify(provenance), recordSha256],
      );
    }
    await verifyInserted(owner, fixture, fixtureSha256, sourceRelease);
    await owner.query("COMMIT");
    return evidence(fixture, fixtureSha256, sourceRelease, fixture.records.length, "inserted");
  } catch (error) {
    await owner.query("ROLLBACK");
    throw error;
  } finally {
    await owner.end();
  }
}

async function loadFixture(): Promise<Fixture> {
  const value = JSON.parse(await readFile(resolve(FIXTURE_PATH), "utf8")) as Partial<Fixture>;
  if (value.schema_version !== EXPECTED_SCHEMA || value.kind !== "local_demo_school_directory" ||
      value.demo_only !== true || value.source?.repository !== "school-tracker" ||
      !/^[0-9a-f]{40}$/.test(value.source?.commit_sha ?? "") ||
      !value.source?.exported_at || !value.source.export_script ||
      value.record_count !== EXPECTED_RECORD_COUNT || !Array.isArray(value.records) ||
      value.records.length !== EXPECTED_RECORD_COUNT || !Array.isArray(value.directory_fields)) {
    throw new LocalDemoSchoolSeedSafetyError("Local demo school fixture metadata is invalid.");
  }
  const fields = new Set(value.directory_fields);
  for (const record of value.records) {
    if (!record || typeof record !== "object" ||
        Object.keys(record).some((field) => !fields.has(field)) ||
        !Object.hasOwn(record, "school_key") || typeof record.school_key !== "string" ||
        record.school_key.trim() === "") {
      throw new LocalDemoSchoolSeedSafetyError("Local demo school fixture contains an invalid record.");
    }
  }
  return value as Fixture;
}

async function inspectExistingSchoolState(connectionString: string): Promise<{
  schoolCount: number;
  snapshotCount: number;
  recordCount: number;
  snapshotId: string | null;
  sourceReleaseId: string | null;
}> {
  const client = new Client({ connectionString, application_name: "tianxing-local-demo-school-inspect", ssl: false });
  await client.connect();
  try {
    const result = await client.query<{
      school_count: number;
      snapshot_count: number;
      record_count: number;
      snapshot_id: string | null;
      source_release_id: string | null;
    }>(`SELECT
      (SELECT count(*)::int FROM schools_schools WHERE organization_id=$1) AS school_count,
      (SELECT count(*)::int FROM schools_snapshots WHERE organization_id=$1) AS snapshot_count,
      (SELECT count(*)::int FROM schools_snapshot_records WHERE organization_id=$1) AS record_count,
      (SELECT id::text FROM schools_snapshots WHERE organization_id=$1 AND status='active') AS snapshot_id,
      (SELECT source_release_id FROM schools_snapshots WHERE organization_id=$1 AND status='active') AS source_release_id`,
      [LOCAL_SYNTHETIC_ORGANIZATION.id]);
    const row = result.rows[0];
    if (!row) throw new LocalDemoSchoolSeedSafetyError("Local school state inspection returned no row.");
    return { schoolCount: row.school_count, snapshotCount: row.snapshot_count, recordCount: row.record_count,
      snapshotId: row.snapshot_id, sourceReleaseId: row.source_release_id };
  } finally {
    await client.end();
  }
}

async function assertNoSchoolRows(client: Client): Promise<void> {
  const result = await client.query<{ schools: number; snapshots: number; records: number }>(`SELECT
    (SELECT count(*)::int FROM schools_schools WHERE organization_id=$1) AS schools,
    (SELECT count(*)::int FROM schools_snapshots WHERE organization_id=$1) AS snapshots,
    (SELECT count(*)::int FROM schools_snapshot_records WHERE organization_id=$1) AS records`,
    [LOCAL_SYNTHETIC_ORGANIZATION.id]);
  const row = result.rows[0];
  if (!row || row.schools !== 0 || row.snapshots !== 0 || row.records !== 0) {
    throw new LocalDemoSchoolSeedSafetyError("Local demo school seed found pre-existing school rows.");
  }
}

async function verifyInserted(client: Client, fixture: Fixture, fixtureSha256: string, sourceRelease: string): Promise<void> {
  const snapshot = await client.query<{ source_release_id: string; manifest_sha256: string; file_set_json: unknown; status: string; record_count: number }>(
    "SELECT source_release_id,manifest_sha256,file_set_json,status,record_count FROM schools_snapshots WHERE id=$1 AND organization_id=$2",
    [SNAPSHOT_ID, LOCAL_SYNTHETIC_ORGANIZATION.id],
  );
  const row = snapshot.rows[0];
  const expectedManifest = sha256SchoolValue({ sourceRelease, fixtureSha256, records: fixture.records.map((record) => record.school_key) });
  if (!row || row.source_release_id !== sourceRelease || row.manifest_sha256 !== expectedManifest ||
      row.status !== "active" || row.record_count !== EXPECTED_RECORD_COUNT) {
    throw new LocalDemoSchoolSeedSafetyError("Local demo school snapshot verification failed.");
  }
  const count = await client.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM schools_snapshot_records WHERE organization_id=$1 AND snapshot_id=$2",
    [LOCAL_SYNTHETIC_ORGANIZATION.id, SNAPSHOT_ID],
  );
  if (count.rows[0]?.count !== EXPECTED_RECORD_COUNT) throw new LocalDemoSchoolSeedSafetyError("Local demo school record count is inconsistent.");
}

function evidence(fixture: Fixture, fixtureSha256: string, sourceRelease: string, recordCount: number, operation: string) {
  const missing = Object.fromEntries(fixture.directory_fields.map((field) => [field,
    fixture.records.filter((record) => record[field] === null).length]));
  return {
    status: "pass",
    demo_only: true,
    operation,
    source_release_id: sourceRelease,
    fixture_path: FIXTURE_PATH,
    fixture_sha256: fixtureSha256,
    source: fixture.source,
    records: recordCount,
    records_with_directory_identity: fixture.records.filter((record) => record.school_name_zh || record.school_name_en).length,
    records_with_missing_fields: missing,
    admissions_records_seeded: 0,
  };
}

function deterministicUuid(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function runCli(environment: Readonly<Record<string, string | undefined>>): Promise<void> {
  const result = await seedLocalDemoSchoolDirectory(readRelease1SyntheticSeedTarget(environment));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const isMainModule = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  runCli(process.env).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown local demo school seed failure.";
    const secrets = [process.env.ONE_ROLE_BASELINE_DATABASE_URL ?? "", process.env.LOCAL_SYNTHETIC_DATABASE_URL ?? ""].filter(Boolean);
    process.stderr.write(`${secrets.reduce((text, secret) => text.replaceAll(secret, "[redacted]"), message)}\n`);
    process.exitCode = 1;
  });
}
