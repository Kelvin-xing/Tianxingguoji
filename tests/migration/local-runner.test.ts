import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  LocalMigrationSafetyError,
  createLocalMigrationOptions,
  readLocalMigrationMode,
  readLocalMigrationTarget,
  verifyMigrationManifest,
} from "../../scripts/db/run-local-migrations.ts";

const MIGRATION_URL =
  "postgresql://tianxing_app:tianxing-local-app-only@127.0.0.1:5432/tianxing";

test("requires one explicit local migration mode", () => {
  assert.equal(readLocalMigrationMode(["--dry-run"]), "dry-run");
  assert.equal(readLocalMigrationMode(["--apply"]), "apply");
  assert.throws(() => readLocalMigrationMode([]), LocalMigrationSafetyError);
  assert.throws(() => readLocalMigrationMode(["--apply", "--dry-run"]), LocalMigrationSafetyError);
});

test("fails closed until the independent one-role baseline exists", () => {
  assert.throws(
    () => readLocalMigrationTarget({
      APP_RUNTIME_MODE: "local-synthetic",
      MIGRATION_DATABASE_URL: MIGRATION_URL,
    }),
    (error: unknown) => error instanceof LocalMigrationSafetyError &&
      error.message.includes("one-role baseline"),
  );
});

test("keeps dry-run and apply options explicit while preserving migration safety policy", () => {
  const target = {
    connectionString: MIGRATION_URL,
    host: "127.0.0.1",
    port: 5432,
    database: "tianxing",
    user: "tianxing_app",
  } as const;
  const dryRun = createLocalMigrationOptions(target, "dry-run");
  const apply = createLocalMigrationOptions(target, "apply");

  assert.equal(dryRun.dryRun, true);
  assert.equal(apply.dryRun, false);
  for (const options of [dryRun, apply]) {
    assert.equal(options.singleTransaction, true);
    assert.equal(options.checkOrder, true);
    assert.equal(options.noLock, false);
    assert.equal(options.advisoryLockMode, "fail");
    assert.equal(options.dir, "db/migrations/*.sql");
    assert.equal(options.useGlob, true);
    assert.equal(options.migrationsSchema, "migration");
    assert.equal(options.migrationsTable, "schema_migrations");
  }
});

test("verifies the committed ordered migration manifest", async () => {
  const manifest = await verifyMigrationManifest();

  assert.equal(manifest.manifestVersion, 1);
  assert.equal(manifest.migrations.length, 27);
  assert.equal(manifest.migrations[0]?.name, "202608021330_001_expand_identity_access.sql");
  assert.equal(
    manifest.migrations.at(-1)?.name,
    "202608180120_028_expand_database_test_identity.sql",
  );
});

test("rejects a changed SQL file before opening a database connection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "local-migration-manifest-"));
  const migrationName = "202608170001_001_expand_example.sql";
  const original = "SELECT 1;\n";
  const manifestPath = join(directory, "manifest.json");
  await writeFile(join(directory, migrationName), "SELECT 2;\n", "utf8");
  await writeFile(
    manifestPath,
    JSON.stringify({
      manifest_version: 1,
      migrations: [
        {
          name: migrationName,
          sha256: createHash("sha256").update(original).digest("hex"),
        },
      ],
    }),
    "utf8",
  );

  await assert.rejects(
    verifyMigrationManifest(directory, manifestPath),
    /Migration checksum mismatch/,
  );
});

test("keeps migration-owner credentials out of the application environment example", async () => {
  const [appEnvironment, migrationEnvironment, ignore, packageJsonText] = await Promise.all([
    readFile(".env.local.example", "utf8"),
    readFile(".env.migration.local.example", "utf8"),
    readFile(".gitignore", "utf8"),
    readFile("package.json", "utf8"),
  ]);
  const packageJson = JSON.parse(packageJsonText) as { scripts: Record<string, string> };

  assert.doesNotMatch(appEnvironment, /MIGRATION_DATABASE_URL/);
  assert.match(migrationEnvironment, /^APP_ENV=development$/m);
  assert.match(migrationEnvironment, /^NODE_ENV=development$/m);
  assert.match(migrationEnvironment, /^ONE_ROLE_BASELINE_EXPECTED_DATABASE=tianxing$/m);
  assert.match(migrationEnvironment, /^ONE_ROLE_BASELINE_DATABASE_URL=postgresql:\/\/tianxing_app:/m);
  assert.doesNotMatch(migrationEnvironment, /MIGRATION_DATABASE_URL/);
  assert.doesNotMatch(migrationEnvironment, /tianxing_migration|tianxing-local-migration-only/);
  assert.match(ignore, /^!\/\.env\.migration\.local\.example$/m);
  assert.equal(packageJson.scripts["db:migrate:local"], "pnpm db:baseline:local");
  assert.equal(packageJson.scripts["db:migrate:local:dry-run"], "pnpm db:baseline:local:dry-run");
  assert.match(packageJson.scripts["db:baseline:local"], /--env-file=\.env\.migration\.local/);
  assert.match(packageJson.scripts["db:baseline:local"], /--apply$/);
});
