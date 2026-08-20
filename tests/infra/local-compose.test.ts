import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const ROOT = new URL("../..", import.meta.url);

test("local compose pins the approved local dependencies to loopback ports", async () => {
  const compose = await source("compose.local.yml");

  assert.match(compose, /image:\s*postgres:17\.10-alpine3\.24/);
  assert.match(compose, /image:\s*localstack\/localstack:4\.14\.0/);
  assert.match(compose, /image:\s*clamav\/clamav:1\.4\.5-debian13-slim/);
  assert.match(compose, /"127\.0\.0\.1:5432:5432"/);
  assert.match(compose, /"127\.0\.0\.1:4566:4566"/);
  assert.match(compose, /"127\.0\.0\.1:3310:3310"/);
  assert.doesNotMatch(compose, /0\.0\.0\.0:/);
});

test("local compose initializes versioned S3 and a scan queue with a DLQ", async () => {
  const compose = await source("compose.local.yml");
  const init = await source("infra/local/localstack/init/10-create-document-resources.sh");

  assert.match(compose, /SERVICES:\s*s3,sqs/);
  assert.match(compose, /\/etc\/localstack\/init\/ready\.d:ro/);
  assert.match(compose, /head-bucket/);
  assert.match(compose, /get-queue-url/);
  assert.doesNotMatch(compose, /PERSISTENCE:/);
  assert.doesNotMatch(compose, /LOCALSTACK_AUTH_TOKEN/);
  assert.match(init, /put-bucket-versioning/);
  assert.match(init, /Status=Enabled/);
  assert.match(init, /deadLetterTargetArn/);
  assert.match(init, /maxReceiveCount/);
});

test("local database bootstrap uses and hardens only the canonical application role", async () => {
  const compose = await source("compose.local.yml");
  const roles = await source("infra/local/postgres/init/001-local-roles.sql");
  const packageJson = JSON.parse(await source("package.json"));

  assert.match(compose, /POSTGRES_USER:\s*tianxing_app/);
  assert.match(compose, /POSTGRES_PASSWORD_FILE:\s*\/run\/secrets\/local_postgres_password/);
  assert.match(compose, /local_postgres_password:\s*\n\s+environment:\s*LOCAL_SYNTHETIC_POSTGRES_PASSWORD/);
  assert.doesNotMatch(compose, /POSTGRES_PASSWORD:/);
  assert.match(compose, /pg_isready -U tianxing_app -d tianxing/);
  assert.doesNotMatch(compose, /tianxing_migration|tianxing-local-migration-only/);
  assert.match(packageJson.scripts["local:up"], /--env-file \.env\.local/);
  assert.match(packageJson.scripts["local:ps"], /--env-file \.env\.local/);
  assert.match(packageJson.scripts["local:down"], /--env-file \.env\.local/);
  assert.match(roles, /ALTER ROLE tianxing_app WITH\s+LOGIN/);
  assert.match(roles, /NOSUPERUSER/);
  assert.match(roles, /NOCREATEDB/);
  assert.match(roles, /NOCREATEROLE/);
  assert.match(roles, /NOINHERIT/);
  assert.match(roles, /NOREPLICATION/);
  assert.match(roles, /NOBYPASSRLS/);
  assert.doesNotMatch(roles, /CREATE ROLE/);
  assert.doesNotMatch(roles, /PASSWORD|tianxing_migration|tianxing_test_/);
  assert.doesNotMatch(roles, /INSERT\s+INTO/i);
});

test("the committed environment example is explicit and local-only", async () => {
  const example = await source(".env.local.example");
  const ignore = await source(".gitignore");
  const packageJson = JSON.parse(await source("package.json"));

  assert.match(example, /^APP_RUNTIME_MODE=local-synthetic$/m);
  assert.match(example, /127\.0\.0\.1/);
  assert.match(example, /^LOCAL_SYNTHETIC_POSTGRES_PASSWORD=not-a-secret$/m);
  assert.match(example, /^LOCAL_SYNTHETIC_DATABASE_URL=postgresql:\/\/tianxing_app:/m);
  assert.doesNotMatch(example, /^LOCAL_SYNTHETIC_(IDENTITY|APPLICATION)_DATABASE_URL=/m);
  assert.doesNotMatch(example, /\.rds\.amazonaws\.com/);
  assert.match(ignore, /^!\/\.env\.local\.example$/m);
  assert.equal(packageJson.dependencies.pg, "8.20.0");
  assert.equal(packageJson.devDependencies.pg, undefined);
});

async function source(path: string): Promise<string> {
  return readFile(new URL(path, ROOT), "utf8");
}
