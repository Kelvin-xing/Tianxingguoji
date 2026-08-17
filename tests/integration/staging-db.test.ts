import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  APPLICATION_DATABASE_ROLE,
  ApplicationDatabaseConfigError,
  createTenantTransactionRunner,
  loadApplicationDatabaseConfig,
  type DatabaseClient,
  type DatabaseQuery,
} from "../../modules/shared/infrastructure/db.ts";

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function readProjectFile(relativePath: string): string {
  return readFileSync(new URL(relativePath, `file://${PROJECT_ROOT}`), "utf8");
}

test("staging root wires a private RDS module to the runtime security group", () => {
  const stagingRoot = readProjectFile("infra/terraform/environments/staging/main.tf");
  const rdsModule = readProjectFile("infra/terraform/modules/rds/main.tf");
  const runtimeModule = readProjectFile("infra/terraform/modules/web-runtime/main.tf");

  assert.match(stagingRoot, /source\s*=\s*"\.\.\/\.\.\/modules\/rds"/);
  assert.match(stagingRoot, /application_security_group_id\s*=\s*module\.web_runtime\.runtime_security_group_id/);
  assert.match(rdsModule, /engine\s*=\s*"postgres"/);
  assert.match(rdsModule, /instance_class\s*=\s*"db\.t4g\.small"/);
  assert.match(rdsModule, /multi_az\s*=\s*true/);
  assert.match(rdsModule, /publicly_accessible\s*=\s*false/);
  assert.match(rdsModule, /storage_encrypted\s*=\s*true/);
  assert.match(rdsModule, /backup_retention_period\s*=\s*7/);
  assert.match(rdsModule, /iam_database_authentication_enabled\s*=\s*true/);
  assert.match(rdsModule, /manage_master_user_password\s*=\s*true/);
  assert.match(rdsModule, /deletion_protection\s*=\s*true/);
  assert.match(rdsModule, /apply_immediately\s*=\s*false/);
  assert.match(rdsModule, /auto_minor_version_upgrade\s*=\s*false/);
  assert.match(rdsModule, /referenced_security_group_id\s*=\s*var\.application_security_group_id/);
  assert.match(rdsModule, /Action\s*=\s*"rds-db:connect"/);
  assert.match(rdsModule, /dbuser:\$\{aws_db_instance\.this\.resource_id\}\/tianxing_app/);
  assert.match(rdsModule, /name\s*=\s*"rds\.force_ssl"/);
  assert.match(runtimeModule, /runtime_to_private_postgresql/);
  assert.match(runtimeModule, /from_port\s*=\s*5432/);
  const databaseSecurityGroup = rdsModule.slice(
    rdsModule.indexOf('resource "aws_security_group" "database"'),
    rdsModule.indexOf('resource "aws_vpc_security_group_ingress_rule" "application_postgresql"'),
  );
  assert.doesNotMatch(databaseSecurityGroup, /egress\s*\{/);
  assert.doesNotMatch(rdsModule, /^\s*password\s*=/im);
});

test("migration grants only RLS-governed CRUD to the IAM application role", () => {
  const migration = readProjectFile(
    "db/migrations/202608030030_008_expand_application_database_role.sql",
  );

  assert.match(
    migration,
    /CREATE ROLE tianxing_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS/,
  );
  assert.match(migration, /GRANT rds_iam TO tianxing_app/);
  assert.match(migration, /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public\.%I TO tianxing_app/);
  assert.match(migration, /ALTER TABLE public\.%I ENABLE ROW LEVEL SECURITY/);
  assert.match(
    migration,
    /CREATE POLICY tianxing_tenant_boundary ON public\.%I\s+FOR ALL TO tianxing_app/,
  );
  assert.match(migration, /current_setting\('app\.organization_id', true\)/);
  assert.doesNotMatch(migration, /\bPASSWORD\b|\bSUPERUSER\b|\bBYPASSRLS\b|\bCREATEDB\b|\bCREATEROLE\b|\bREPLICATION\b/);
});

test("application database configuration accepts only a Hong Kong RDS endpoint and TLS", () => {
  assert.equal(APPLICATION_DATABASE_ROLE, "tianxing_app");
  assert.deepEqual(
    loadApplicationDatabaseConfig({
      DATABASE_HOST: "release1-staging.cluster-abc123.ap-east-1.rds.amazonaws.com",
      DATABASE_NAME: "tianxing",
      DATABASE_PORT: "5432",
    }),
    {
      host: "release1-staging.cluster-abc123.ap-east-1.rds.amazonaws.com",
      port: 5432,
      database: "tianxing",
      user: "tianxing_app",
      applicationName: "tianxing-application",
      ssl: { rejectUnauthorized: true },
    },
  );

  assertDatabaseConfigError(
    { DATABASE_HOST: "db.example.invalid", DATABASE_NAME: "tianxing" },
    "DATABASE_HOST_INVALID",
  );
  assertDatabaseConfigError(
    {
      DATABASE_HOST: "release1-staging.cluster-abc123.ap-east-1.rds.amazonaws.com",
      DATABASE_NAME: "other_database",
    },
    "DATABASE_NAME_INVALID",
  );
  assertDatabaseConfigError(
    {
      DATABASE_HOST: "release1-staging.cluster-abc123.ap-east-1.rds.amazonaws.com",
      DATABASE_NAME: "tianxing",
      DATABASE_PORT: "5433",
    },
    "DATABASE_PORT_INVALID",
  );
});

test("tenant transaction pins organization and actor settings with parameterized SET LOCAL calls", async () => {
  const calls: DatabaseQuery[] = [];
  const client: DatabaseClient = {
    async query<Row>(query: DatabaseQuery) {
      calls.push(query);
      return { rows: [] as Row[] };
    },
    release() {},
  };
  const runner = createTenantTransactionRunner({
    async connect() {
      return client;
    },
  });

  const result = await runner.run(
    {
      organizationId: "11111111-1111-4111-8111-111111111111",
      actorUserId: "22222222-2222-4222-8222-222222222222",
    },
    async (transaction) => {
      await transaction.query({ text: "SELECT $1::text", values: ["safe-value"] });
      return "committed";
    },
  );

  assert.equal(result, "committed");
  assert.deepEqual(calls, [
    { text: "BEGIN" },
    {
      text: "SELECT set_config('app.organization_id', $1, true)",
      values: ["11111111-1111-4111-8111-111111111111"],
    },
    {
      text: "SELECT set_config('app.actor_user_id', $1, true)",
      values: ["22222222-2222-4222-8222-222222222222"],
    },
    { text: "SELECT $1::text", values: ["safe-value"] },
    { text: "COMMIT" },
  ]);
});

test("tenant transaction rolls back and releases a client when the operation fails", async () => {
  const calls: DatabaseQuery[] = [];
  let released = false;
  const client: DatabaseClient = {
    async query<Row>(query: DatabaseQuery) {
      calls.push(query);
      return { rows: [] as Row[] };
    },
    release() {
      released = true;
    },
  };
  const runner = createTenantTransactionRunner({ async connect() { return client; } });

  await assert.rejects(
    runner.run(
      {
        organizationId: "11111111-1111-4111-8111-111111111111",
        actorUserId: "22222222-2222-4222-8222-222222222222",
      },
      async () => {
        throw new Error("operation failed");
      },
    ),
    new Error("operation failed"),
  );

  assert.equal(released, true);
  assert.deepEqual(calls.at(-1), { text: "ROLLBACK" });
});

function assertDatabaseConfigError(
  environment: Readonly<Record<string, string | undefined>>,
  code: ApplicationDatabaseConfigError["code"],
): void {
  assert.throws(() => loadApplicationDatabaseConfig(environment), (error: unknown) => {
    assert.ok(error instanceof ApplicationDatabaseConfigError);
    assert.equal(error.code, code);
    return true;
  });
}
