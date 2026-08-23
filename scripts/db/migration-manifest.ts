import { createHash } from "node:crypto";
import { readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { MIGRATION_CONFIG } from "../../db/migrate.config.ts";

export const MIGRATION_DIRECTORY = "db/migrations";
export const MIGRATION_MANIFEST_PATH = "db/migrations/manifest.json";
export const NEON_TEST_DATABASE = "txgj_env01_test";
export const NEON_TEST_MIGRATION_LOGIN = "env01_migration_login";
export const EXPECTED_MIGRATION_COUNT = 33;
export const EXPECTED_LAST_MIGRATION =
  "202608230050_034_complete_case_document_registration.sql";
export const EXPECTED_LAST_MIGRATION_SHA256 =
  "e8cced82a8b978a4822f5c802c1a35078c5444a3d1a927845ea296c4eb404f78";

const SHA256 = /^[a-f0-9]{64}$/;
const CANONICAL_MIGRATION_NAME = /^\d{12}_\d{3}_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;

export type MigrationManifestEntry = Readonly<{
  name: string;
  sha256: string;
}>;

export type MigrationManifest = Readonly<{
  manifestVersion: 1;
  manifestSha256: string;
  migrations: readonly MigrationManifestEntry[];
}>;

export class MigrationManifestSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationManifestSafetyError";
  }
}

export async function verifyOrderedMigrationManifest(
  migrationDirectory = MIGRATION_DIRECTORY,
  manifestPath = MIGRATION_MANIFEST_PATH,
): Promise<MigrationManifest> {
  let entries;
  let rawManifest: string;
  try {
    [entries, rawManifest] = await Promise.all([
      readdir(migrationDirectory, { withFileTypes: true }),
      readFile(manifestPath, "utf8"),
    ]);
  } catch {
    throw new MigrationManifestSafetyError("Migration manifest files could not be read.");
  }

  const migrationNames = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();
  const manifest = parseManifest(rawManifest);
  const manifestNames = manifest.migrations.map(({ name }) => name);

  if (
    migrationNames.length !== manifestNames.length ||
    migrationNames.some((name, index) => name !== manifestNames[index])
  ) {
    throw new MigrationManifestSafetyError(
      "Migration manifest does not match the ordered SQL files.",
    );
  }

  await Promise.all(
    manifest.migrations.map(async ({ name, sha256 }) => {
      const contents = await readFile(resolve(migrationDirectory, name));
      const actual = createHash("sha256").update(contents).digest("hex");
      if (actual !== sha256) {
        throw new MigrationManifestSafetyError(`Migration checksum mismatch: ${name}`);
      }
    }),
  );

  return manifest;
}

export async function writeOrderedMigrationManifest(
  migrationDirectory = MIGRATION_DIRECTORY,
  manifestPath = MIGRATION_MANIFEST_PATH,
): Promise<MigrationManifest> {
  let entries;
  let rawManifest: string;
  try {
    [entries, rawManifest] = await Promise.all([
      readdir(migrationDirectory, { withFileTypes: true }),
      readFile(manifestPath, "utf8"),
    ]);
  } catch {
    throw new MigrationManifestSafetyError("Migration manifest files could not be read.");
  }

  const migrationNames = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();
  if (migrationNames.some((name) => !CANONICAL_MIGRATION_NAME.test(name))) {
    throw new MigrationManifestSafetyError("Migration file name is not canonical.");
  }

  const existing = parseManifest(rawManifest);
  if (migrationNames.length < existing.migrations.length) {
    throw new MigrationManifestSafetyError("Migration manifest history cannot be removed.");
  }

  const migrations: MigrationManifestEntry[] = [];
  for (const [index, name] of migrationNames.entries()) {
    const contents = await readFile(resolve(migrationDirectory, name));
    const sha256 = createHash("sha256").update(contents).digest("hex");
    const historical = existing.migrations[index];
    if (historical !== undefined && historical.name !== name) {
      throw new MigrationManifestSafetyError("Migration manifest history cannot be reordered.");
    }
    if (historical !== undefined && historical.sha256 !== sha256) {
      throw new MigrationManifestSafetyError(`Migration checksum mismatch: ${name}`);
    }
    migrations.push(Object.freeze({ name, sha256 }));
  }

  const canonical = serializeManifest(migrations);
  const expected = parseManifest(canonical);
  const temporaryPath = `${manifestPath}.${process.pid}.tmp`;
  try {
    await writeFile(temporaryPath, canonical, { encoding: "utf8", flag: "wx" });
    const temporary = await verifyOrderedMigrationManifest(migrationDirectory, temporaryPath);
    if (!manifestsEqual(expected, temporary)) {
      throw new MigrationManifestSafetyError("Generated migration manifest failed verification.");
    }
    await rename(temporaryPath, manifestPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }

  const committed = await verifyOrderedMigrationManifest(migrationDirectory, manifestPath);
  if (!manifestsEqual(expected, committed)) {
    throw new MigrationManifestSafetyError("Written migration manifest failed verification.");
  }
  return committed;
}

export function assertNeonTestManifest(manifest: MigrationManifest): void {
  const last = manifest.migrations.at(-1);
  if (
    manifest.migrations.length !== EXPECTED_MIGRATION_COUNT ||
    last?.name !== EXPECTED_LAST_MIGRATION ||
    last.sha256 !== EXPECTED_LAST_MIGRATION_SHA256
  ) {
    throw new MigrationManifestSafetyError(
      "Neon test bootstrap requires the frozen 33-migration manifest.",
    );
  }
}

export function manifestsEqual(
  left: MigrationManifest,
  right: MigrationManifest,
): boolean {
  return (
    left.manifestVersion === right.manifestVersion &&
    left.manifestSha256 === right.manifestSha256 &&
    left.migrations.length === right.migrations.length &&
    left.migrations.every(
      (entry, index) =>
        entry.name === right.migrations[index]?.name &&
        entry.sha256 === right.migrations[index]?.sha256,
    )
  );
}

export function createNeonTestPlanEvidence(manifest: MigrationManifest) {
  assertNeonTestManifest(manifest);
  return Object.freeze({
    mode: "plan",
    endpoint_kind: "neon-direct",
    target_database: NEON_TEST_DATABASE,
    migration_login: NEON_TEST_MIGRATION_LOGIN,
    tls: Object.freeze({ verified: false, reject_unauthorized: true }),
    manifest: Object.freeze({
      version: manifest.manifestVersion,
      count: manifest.migrations.length,
      sha256: manifest.manifestSha256,
      migrations: manifest.migrations,
    }),
    transaction_policy: Object.freeze({
      tool: MIGRATION_CONFIG.tool.name,
      version: MIGRATION_CONFIG.tool.version,
      check_order: MIGRATION_CONFIG.checkOrder,
      single_transaction: MIGRATION_CONFIG.singleTransaction,
      advisory_lock_mode: MIGRATION_CONFIG.advisoryLockMode,
      no_lock: false,
    }),
    status: "pass",
  });
}

function parseManifest(rawManifest: string): MigrationManifest {
  let value: unknown;
  try {
    value = JSON.parse(rawManifest) as unknown;
  } catch {
    throw new MigrationManifestSafetyError("Migration manifest is invalid.");
  }
  if (!isRecord(value) || value.manifest_version !== 1 || !Array.isArray(value.migrations)) {
    throw new MigrationManifestSafetyError("Migration manifest is invalid.");
  }

  const seen = new Set<string>();
  const migrations = value.migrations.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.name !== "string" ||
      !entry.name.endsWith(".sql") ||
      typeof entry.sha256 !== "string" ||
      !SHA256.test(entry.sha256) ||
      seen.has(entry.name)
    ) {
      throw new MigrationManifestSafetyError("Migration manifest entry is invalid.");
    }
    seen.add(entry.name);
    return Object.freeze({ name: entry.name, sha256: entry.sha256 });
  });

  return Object.freeze({
    manifestVersion: 1 as const,
    manifestSha256: createHash("sha256").update(rawManifest).digest("hex"),
    migrations: Object.freeze(migrations),
  });
}

function serializeManifest(migrations: readonly MigrationManifestEntry[]): string {
  const entries = migrations.map(({ name, sha256 }) =>
    `    { "name": ${JSON.stringify(name)}, "sha256": ${JSON.stringify(sha256)} }`
  );
  return [
    "{",
    '  "manifest_version": 1,',
    '  "migrations": [',
    entries.join(",\n"),
    "  ]",
    "}",
    "",
  ].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function runPlanCli(arguments_: readonly string[]): Promise<void> {
  if (arguments_.length !== 1) {
    throw new MigrationManifestSafetyError("Specify --neon-test-plan or --write.");
  }
  if (arguments_[0] === "--write") {
    const manifest = await writeOrderedMigrationManifest();
    process.stdout.write(`${JSON.stringify({
      status: "pass",
      mode: "write",
      count: manifest.migrations.length,
      last_migration: manifest.migrations.at(-1)?.name ?? null,
      manifest_sha256: manifest.manifestSha256,
    })}\n`);
    return;
  }
  if (arguments_[0] !== "--neon-test-plan") {
    throw new MigrationManifestSafetyError("Specify --neon-test-plan or --write.");
  }
  const manifest = await verifyOrderedMigrationManifest();
  process.stdout.write(`${JSON.stringify(createNeonTestPlanEvidence(manifest), null, 2)}\n`);
}

const isMainModule =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  runPlanCli(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Migration plan failed.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
