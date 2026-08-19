import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { MIGRATION_CONFIG } from "../../db/migrate.config.ts";

export const MIGRATION_DIRECTORY = "db/migrations";
export const MIGRATION_MANIFEST_PATH = "db/migrations/manifest.json";
export const NEON_TEST_DATABASE = "txgj_env01_test";
export const NEON_TEST_MIGRATION_LOGIN = "env01_migration_login";
export const EXPECTED_MIGRATION_COUNT = 27;
export const EXPECTED_LAST_MIGRATION =
  "202608180120_028_expand_database_test_identity.sql";
export const EXPECTED_LAST_MIGRATION_SHA256 =
  "a03e584fac57648abdc4049dbd05e00c35d2ec1a3fc3b06297b4b757574332bb";

const SHA256 = /^[a-f0-9]{64}$/;

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

export function assertNeonTestManifest(manifest: MigrationManifest): void {
  const last = manifest.migrations.at(-1);
  if (
    manifest.migrations.length !== EXPECTED_MIGRATION_COUNT ||
    last?.name !== EXPECTED_LAST_MIGRATION ||
    last.sha256 !== EXPECTED_LAST_MIGRATION_SHA256
  ) {
    throw new MigrationManifestSafetyError(
      "Neon test bootstrap requires the frozen 27-migration manifest.",
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function runPlanCli(arguments_: readonly string[]): Promise<void> {
  if (arguments_.length !== 1 || arguments_[0] !== "--neon-test-plan") {
    throw new MigrationManifestSafetyError("Specify --neon-test-plan.");
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
