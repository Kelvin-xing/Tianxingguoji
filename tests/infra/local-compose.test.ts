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
  assert.match(compose, /SQS_ENDPOINT_STRATEGY:\s*path/);
  assert.match(compose, /\/etc\/localstack\/init\/ready\.d:ro/);
  assert.match(compose, /head-bucket/);
  assert.match(compose, /get-queue-url/);
  assert.doesNotMatch(compose, /PERSISTENCE:/);
  assert.doesNotMatch(compose, /LOCALSTACK_AUTH_TOKEN/);
  assert.match(init, /put-bucket-versioning/);
  assert.match(init, /Status=Enabled/);
  assert.match(init, /deadLetterTargetArn/);
  assert.match(init, /maxReceiveCount[^\n]*3/);
});

test("local document queue pins the 180-second visibility timeout on create and every initialization", async () => {
  const init = await source("infra/local/localstack/init/10-create-document-resources.sh");
  const createQueueStart = init.indexOf(
    'if ! awslocal sqs get-queue-url --queue-name "${queue}"',
  );
  const createQueueEnd = init.indexOf("\ndlq_url=", createQueueStart);

  assert.notEqual(createQueueStart, -1);
  assert.notEqual(createQueueEnd, -1);
  assert.match(init, /^queue_visibility_timeout="180"$/m);
  assert.match(
    init.slice(createQueueStart, createQueueEnd),
    /--attributes "VisibilityTimeout=\$\{queue_visibility_timeout\}"/,
  );
  assert.match(init, /"VisibilityTimeout":"%s"/);
  assert.match(init, /--attributes "\$\{queue_attributes\}"/);
  assert.doesNotMatch(init, /queue_visibility_timeout="\$\{/);
});

test("local document bucket CORS is limited to the configured loopback browser origin", async () => {
  const compose = await source("compose.local.yml");
  const init = await source("infra/local/localstack/init/10-create-document-resources.sh");
  const cors = jsonHeredoc(init, "cors_configuration_file");

  assert.match(compose, /LOCALSTACK_BROWSER_ORIGIN:\s*"http:\/\/localhost:3000"/);
  assert.match(init, /LOCALSTACK_BROWSER_ORIGIN:\?LOCALSTACK_BROWSER_ORIGIN is required/);
  assert.match(init, /http:\/\/127\.0\.0\.1:\*\|http:\/\/localhost:\*/);
  assert.match(init, /put-bucket-cors/);
  assert.deepEqual(cors, {
    CORSRules: [{
      ID: "local-browser-document-transfer",
      AllowedHeaders: ["content-type", "x-amz-checksum-sha256"],
      AllowedMethods: ["GET", "HEAD", "PUT"],
      AllowedOrigins: ["${browser_origin}"],
      MaxAgeSeconds: 300,
    }],
  });
});

test("local document queue policy grants only exact S3 delivery and local-synthetic requeue", async () => {
  const init = await source("infra/local/localstack/init/10-create-document-resources.sh");
  const queuePolicyAttributes = record(jsonHeredoc(init, "queue_policy_attributes_file"));
  const queuePolicyText = queuePolicyAttributes.Policy;
  if (typeof queuePolicyText !== "string") assert.fail("queue policy must be a JSON string attribute");
  const queuePolicy = JSON.parse(queuePolicyText);
  const notification = jsonHeredoc(init, "notification_configuration_file");

  assert.deepEqual(Object.keys(queuePolicyAttributes), ["Policy"]);
  assert.deepEqual(queuePolicy, {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "AllowExactDocumentBucketEvents",
        Effect: "Allow",
        Principal: { Service: "s3.amazonaws.com" },
        Action: "sqs:SendMessage",
        Resource: "${queue_arn}",
        Condition: {
          ArnEquals: { "aws:SourceArn": "arn:aws:s3:::${bucket}" },
          StringEquals: { "aws:SourceAccount": "${account_id}" },
        },
      },
      {
        Sid: "AllowExactLocalSyntheticRequeue",
        Effect: "Allow",
        Principal: { AWS: "arn:aws:iam::${account_id}:root" },
        Action: "sqs:SendMessage",
        Resource: "${queue_arn}",
      },
    ],
  });
  assertNoQueuePolicyWildcards(queuePolicy);
  assert.match(init, /put-bucket-notification-configuration/);
  assert.deepEqual(notification, {
    QueueConfigurations: [{
      Id: "document-object-created-put",
      QueueArn: "${queue_arn}",
      Events: ["s3:ObjectCreated:Put"],
      Filter: {
        Key: {
          FilterRules: [{ Name: "prefix", Value: "documents/" }],
        },
      },
    }],
  });
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
  assert.match(
    example,
    /^LOCAL_SYNTHETIC_DOCUMENT_WORKER_CONTEXT_ID=10000000-0000-4000-8000-000000000901$/m,
  );
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
