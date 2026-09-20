import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getLocalTrialDemoPrincipal,
  LOCAL_TRIAL_DEMO_PRINCIPALS,
} from "../../../modules/identity/infrastructure/local-trial-demo-principals.ts";
import { isLocalSyntheticRole } from "../../../modules/identity/infrastructure/local-synthetic-login.ts";

test("local trial demo aliases resolve to actual trial grades and fixed categories", () => {
  assert.deepEqual(LOCAL_TRIAL_DEMO_PRINCIPALS.map((principal) => principal.loginRole), [
    "l1", "l2_international", "l2_local", "l3",
  ]);
  assert.equal(getLocalTrialDemoPrincipal("l2_international").role, "l2");
  assert.deepEqual(getLocalTrialDemoPrincipal("l2_international").categories, ["international_school"]);
  assert.equal(getLocalTrialDemoPrincipal("l2_local").role, "l2");
  assert.equal(getLocalTrialDemoPrincipal("l3").role, "l3");
  assert.equal(isLocalSyntheticRole("l2_international"), true);
  assert.equal(isLocalSyntheticRole("not-a-demo-role"), false);
});

test("local trial demo seed is local-only and uses fixed synthetic data", async () => {
  const source = await readFile("scripts/db/seed-local-trial-demo.ts", "utf8");
  assert.match(source, /loadLocalSyntheticConfig/);
  assert.match(source, /LOCAL-TRIAL-INTERNATIONAL/);
  assert.match(source, /LOCAL-TRIAL-LOCAL/);
  assert.doesNotMatch(source, /production-aws|DATABASE_HOST|S3_BUCKET/);
});

test("local trial demo command requires both runtime and migration env files", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
    scripts: Record<string, string>;
  };
  assert.equal(
    packageJson.scripts["db:seed:local-trial-demo"],
    "node --env-file=.env.local --env-file=.env.migration.local --conditions=react-server scripts/db/seed-local-trial-demo.ts",
  );

  const directory = await mkdtemp(join(tmpdir(), "tianxing-trial-env-"));
  try {
    const localEnv = join(directory, ".env.local");
    const migrationEnv = join(directory, ".env.migration.local");
    const probe = join(directory, "probe.mjs");
    await writeFile(localEnv, [
      "APP_ENV=development",
      "NODE_ENV=development",
      "APP_RUNTIME_MODE=local-synthetic",
      "AUTH_MODE=database-test",
      "LOCAL_SYNTHETIC_DATABASE_URL=postgresql://tianxing_app:not-a-secret@127.0.0.1:5432/tianxing",
      "LOCAL_SYNTHETIC_DEPENDENCY_TIMEOUT_MS=2000",
      "LOCAL_SYNTHETIC_ORGANIZATION_ID=51000000-0000-4000-8000-000000000001",
      "",
    ].join("\n"));
    await writeFile(migrationEnv, [
      "APP_ENV=development",
      "NODE_ENV=development",
      "ONE_ROLE_BASELINE_EXPECTED_DATABASE=tianxing",
      "ONE_ROLE_BASELINE_DATABASE_URL=postgresql://tianxing_app:not-a-secret@127.0.0.1:5432/tianxing",
      "",
    ].join("\n"));
    await writeFile(probe, [
      'import { loadLocalSyntheticConfig } from "' + join(process.cwd(), "lib/runtime/local-synthetic-config.ts") + '";',
      'import { readLocalRelease1SeedTarget } from "' + join(process.cwd(), "scripts/db/seed-local-release1.ts") + '";',
      "loadLocalSyntheticConfig();",
      "readLocalRelease1SeedTarget();",
      "process.stdout.write('ready\\n');",
      "",
    ].join("\n"));

    const missingLocal = await runEnvProbe(probe, [migrationEnv]);
    assert.notEqual(missingLocal.code, 0);
    assert.doesNotMatch(missingLocal.stdout, /ready/);

    const missingMigration = await runEnvProbe(probe, [localEnv]);
    assert.notEqual(missingMigration.code, 0);
    assert.doesNotMatch(missingMigration.stdout, /ready/);

    const complete = await runEnvProbe(probe, [localEnv, migrationEnv]);
    assert.equal(complete.code, 0, complete.stderr);
    assert.equal(complete.stdout, "ready\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function runEnvProbe(
  probe: string,
  envFiles: readonly string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      ...envFiles.map((file) => `--env-file=${file}`),
      "--conditions=react-server",
      probe,
    ], { cwd: process.cwd() });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}
