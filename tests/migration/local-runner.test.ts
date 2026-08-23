import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  MigrationManifestSafetyError,
  writeOrderedMigrationManifest,
} from "../../scripts/db/migration-manifest.ts";

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
  assert.equal(manifest.migrations.length, 31);
  assert.equal(manifest.migrations[0]?.name, "202608021330_001_expand_identity_access.sql");
  assert.equal(
    manifest.migrations.at(-1)?.name,
    "202608230030_032_expand_case_referral_source_assignments.sql",
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

test("writes a deterministic append-only migration manifest and rejects history drift", async () => {
  const directory = await mkdtemp(join(tmpdir(), "migration-manifest-writer-"));
  const manifestPath = join(directory, "manifest.json");
  const firstName = "202608230001_001_expand_example.sql";
  const secondName = "202608230002_002_expand_example.sql";
  const firstSql = "SELECT 1;\n";
  const firstSha = createHash("sha256").update(firstSql).digest("hex");
  try {
    await writeFile(join(directory, firstName), firstSql, "utf8");
    await writeFile(
      manifestPath,
      `{\n  "manifest_version": 1,\n  "migrations": [\n    { "name": "${firstName}", "sha256": "${firstSha}" }\n  ]\n}\n`,
      "utf8",
    );
    await writeFile(join(directory, secondName), "SELECT 2;\n", "utf8");

    const appended = await writeOrderedMigrationManifest(directory, manifestPath);
    const firstWrite = await readFile(manifestPath, "utf8");
    assert.deepEqual(appended.migrations.map(({ name }) => name), [firstName, secondName]);
    await writeOrderedMigrationManifest(directory, manifestPath);
    assert.equal(await readFile(manifestPath, "utf8"), firstWrite);

    await writeFile(join(directory, firstName), "SELECT 3;\n", "utf8");
    await assert.rejects(
      writeOrderedMigrationManifest(directory, manifestPath),
      (error: unknown) => error instanceof MigrationManifestSafetyError &&
        error.message === `Migration checksum mismatch: ${firstName}`,
    );
    await writeFile(join(directory, firstName), firstSql, "utf8");

    const reordered = JSON.parse(firstWrite) as {
      manifest_version: 1;
      migrations: { name: string; sha256: string }[];
    };
    reordered.migrations.reverse();
    await writeFile(manifestPath, JSON.stringify(reordered), "utf8");
    await assert.rejects(
      writeOrderedMigrationManifest(directory, manifestPath),
      /Migration manifest history cannot be reordered/,
    );

    await writeFile(manifestPath, firstWrite, "utf8");
    await unlink(join(directory, firstName));
    await assert.rejects(
      writeOrderedMigrationManifest(directory, manifestPath),
      /Migration manifest history cannot be removed|Migration manifest history cannot be reordered/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
