import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const ROOT = new URL("../..", import.meta.url);

test("local compose only starts PostgreSQL; file dependencies are retired", async () => {
  const compose = await source("compose.local.yml");

  assert.match(compose, /image:\s*postgres:17\.10-alpine3\.24/);
  assert.match(compose, /"127\.0\.0\.1:5432:5432"/);
  assert.doesNotMatch(compose, /localstack|clamav|4566|3310/i);
  assert.doesNotMatch(compose, /0\.0\.0\.0:/);
});

test("local compose does not initialize a local S3 or scan queue", async () => {
  const compose = await source("compose.local.yml");
  assert.doesNotMatch(compose, /SERVICES:\s*s3,sqs/);
  assert.doesNotMatch(compose, /localstack|clamav|4566|3310/i);
});

test("local compose does not expose a document queue", async () => {
  const compose = await source("compose.local.yml");
  assert.doesNotMatch(compose, /sqs|queue|localstack/i);
});

test("local compose does not expose a local document bucket or CORS endpoint", async () => {
  const compose = await source("compose.local.yml");
  assert.doesNotMatch(compose, /localstack|LOCALSTACK_BROWSER_ORIGIN|s3|cors/i);
});

test("legacy LocalStack initialization remains outside the local compose contract", async () => {
  const compose = await source("compose.local.yml");
  const init = await source("infra/local/localstack/init/10-create-document-resources.sh");
  assert.doesNotMatch(compose, /localstack/i);
  assert.match(init, /put-bucket-versioning|put-bucket-notification-configuration/);
});

test("local database bootstrap uses and hardens only the canonical application role", async () => {
  const compose = await source("compose.local.yml");
  const roles = await source("infra/local/postgres/init/001-local-roles.sh");
  const healthcheck = await source("infra/local/postgres/healthcheck.sh");
  const packageJson = JSON.parse(await source("package.json"));

  assert.match(compose, /POSTGRES_USER:\s*postgres/);
  assert.match(compose, /POSTGRES_PASSWORD_FILE:\s*\/run\/secrets\/local_postgres_password/);
  assert.match(compose, /local_postgres_password:\s*\n\s+environment:\s*LOCAL_SYNTHETIC_POSTGRES_PASSWORD/);
  assert.doesNotMatch(compose, /POSTGRES_PASSWORD:/);
  assert.match(compose, /tianxing-postgres-healthcheck/);
  assert.doesNotMatch(compose, /pg_isready/);
  assert.doesNotMatch(compose, /tianxing_migration|tianxing-local-migration-only/);
  assert.match(packageJson.scripts["local:up"], /--env-file \.env\.local/);
  assert.match(packageJson.scripts["local:ps"], /--env-file \.env\.local/);
  assert.match(packageJson.scripts["local:down"], /--env-file \.env\.local/);
  assert.match(roles, /CREATE ROLE tianxing_app WITH\s+LOGIN/);
  assert.match(roles, /set -eu/);
  assert.match(roles, /--set=ON_ERROR_STOP=1/);
  assert.match(roles, /PASSWORD :'app_password'/);
  assert.match(roles, /NOSUPERUSER/);
  assert.match(roles, /NOCREATEDB/);
  assert.match(roles, /NOCREATEROLE/);
  assert.match(roles, /NOINHERIT/);
  assert.match(roles, /NOREPLICATION/);
  assert.match(roles, /NOBYPASSRLS/);
  assert.match(roles, /ALTER DATABASE tianxing OWNER TO tianxing_app/);
  assert.match(roles, /ALTER ROLE postgres NOLOGIN/);
  assert.match(roles, /POSTGRES_PASSWORD_FILE/);
  assert.doesNotMatch(roles, /tianxing_migration|tianxing_test_|not-a-secret/);
  assert.doesNotMatch(roles, /INSERT\s+INTO/i);
  assert.match(healthcheck, /--username=tianxing_app/);
  assert.match(healthcheck, /NOT application_role\.rolsuper/);
  assert.match(healthcheck, /NOT application_role\.rolinherit/);
  assert.match(healthcheck, /owner_role\.rolname = 'tianxing_app'/);
  assert.match(healthcheck, /bootstrap_role\.rolname = 'postgres'/);
  assert.match(healthcheck, /NOT bootstrap_role\.rolcanlogin/);
  assert.match(healthcheck, /count\(\*\).*rolcanlogin\) = 1/);
});

test("the committed environment example is explicit and local-only", async () => {
  const example = await source(".env.local.example");
  const ignore = await source(".gitignore");
  const packageJson = JSON.parse(await source("package.json"));

  assert.match(example, /^APP_RUNTIME_MODE=local-synthetic$/m);
  assert.match(example, /127\.0\.0\.1/);
  assert.match(example, /^LOCAL_SYNTHETIC_POSTGRES_PASSWORD=not-a-secret$/m);
  assert.match(example, /^LOCAL_SYNTHETIC_DATABASE_URL=postgresql:\/\/tianxing_app:/m);
  assert.match(
    example,
    /^LOCAL_SYNTHETIC_ORGANIZATION_ID=51000000-0000-4000-8000-000000000001$/m,
  );
  assert.match(example, /^DOCUMENT_TRANSPORT_MODE=deterministic-fake$/m);
  assert.match(example, /^DOCUMENT_FAKE_REGION=ap-east-1$/m);
  assert.match(example, /^DOCUMENT_FAKE_BUCKET=tianxing-local-documents$/m);
  assert.match(example, /^DOCUMENT_FAKE_ORIGIN=http:\/\/localhost:3000$/m);
  assert.match(example, /^DOCUMENT_FAKE_ORGANIZATION_ID=51000000-0000-4000-8000-000000000001$/m);
  assert.match(example, /^DOCUMENT_FAKE_WORKER_CONTEXT_ID=10000000-0000-4000-8000-000000000901$/m);
  assert.doesNotMatch(example, /^LOCAL_SYNTHETIC_(LOCALSTACK|AWS_REGION|S3|SQS|CLAMAV|DOCUMENT_WORKER)/m);
  assert.doesNotMatch(example, /^LOCAL_SYNTHETIC_(IDENTITY|APPLICATION)_DATABASE_URL=/m);
  assert.doesNotMatch(example, /\.rds\.amazonaws\.com/);
  assert.match(ignore, /^!\/\.env\.local\.example$/m);
  assert.equal(packageJson.dependencies.pg, "8.20.0");
  assert.equal(packageJson.devDependencies.pg, undefined);
});

async function source(path: string): Promise<string> {
  return readFile(new URL(path, ROOT), "utf8");
}

function jsonHeredoc(text: string, variableName: string): unknown {
  const marker = `cat >"${"${"}${variableName}}" <<EOF\n`;
  const start = text.indexOf(marker);
  assert.notEqual(start, -1, `missing ${variableName} heredoc`);
  const contentStart = start + marker.length;
  const end = text.indexOf("\nEOF", contentStart);
  assert.notEqual(end, -1, `unterminated ${variableName} heredoc`);
  return JSON.parse(text.slice(contentStart, end));
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    assert.fail("expected a JSON object");
  }
  return value as Record<string, unknown>;
}

function assertNoQueuePolicyWildcards(policy: unknown): void {
  const policyRecord = record(policy);
  const statements = policyRecord.Statement;
  if (!Array.isArray(statements)) assert.fail("queue policy statements must be an array");

  assert.equal(statements.length, 2);
  for (const statement of statements) {
    const statementRecord = record(statement);
    assert.notEqual(statementRecord.Principal, "*");
    assert.equal(statementRecord.Action, "sqs:SendMessage");
    assert.equal(statementRecord.Resource, "${queue_arn}");
    assert.doesNotMatch(JSON.stringify(statementRecord.Principal), /\*/);
    assert.doesNotMatch(JSON.stringify(statementRecord.Condition ?? null), /\*/);
  }
}
