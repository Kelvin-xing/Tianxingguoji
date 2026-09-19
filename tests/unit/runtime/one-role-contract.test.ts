import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("one-role baseline is independent, executable, and still unapplied", async () => {
  const manifest = JSON.parse(await readFile("db/baselines/one-role/manifest.json", "utf8")) as {
    baseline_id: string;
    status: string;
    canonical_login_role: string;
    source_history_manifest: string;
    source_migrations: {name:string;source_sha256:string}[];
    generated_files: unknown[];
  };
  assert.equal(manifest.baseline_id, "tianxing-one-role-v1");
  assert.equal(manifest.status, "executable-unapplied");
  assert.equal(manifest.canonical_login_role, "tianxing_app");
  assert.equal(manifest.source_history_manifest, "db/migrations/manifest.json");
  const sourceManifest=JSON.parse(await readFile(manifest.source_history_manifest,"utf8")) as {migrations:unknown[]};
  assert.deepEqual(manifest.source_migrations.map(item=>({name:item.name,sha256:item.source_sha256})),sourceManifest.migrations);
  assert.equal(manifest.generated_files.length,sourceManifest.migrations.length+1);
});

test("runtime contract contains no inherited test-group preflight", async () => {
  const source = await readFile("modules/shared/infrastructure/db.ts", "utf8");
  const identity = await readFile(
    "modules/identity/infrastructure/postgresql-database-test-repository.ts",
    "utf8",
  );
  assert.doesNotMatch(source, /pg_has_role|requiredGroupRole/);
  assert.doesNotMatch(identity, /pg_has_role|TEST_IDENTITY_GROUP_ROLE/);
});
