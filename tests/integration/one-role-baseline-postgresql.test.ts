import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";

import { Client } from "pg";

import {
  ONE_ROLE_BASELINE_ID,
  ONE_ROLE_CANONICAL_ROLE,
  ONE_ROLE_SOURCE_COUNT,
  verifyCommittedOneRoleBaseline,
} from "../../scripts/db/generate-one-role-baseline.ts";
import {
  assertOneRoleBaselinePostflight,
  assertOneRoleBaselinePreflight,
  createOneRoleBaselineClientConfig,
  executeOneRoleBaselineRun,
  inspectOneRoleBaselineDatabase,
  type OneRoleBaselineDatabaseState,
  type OneRoleBaselineTarget,
} from "../../scripts/db/run-one-role-baseline.ts";

const POSTGRES_IMAGE = "postgres:17.10-alpine3.24";
const POSTGRES_MAJOR = 17;

test("dry-runs and applies the one-role baseline on disposable PostgreSQL 17", {
  timeout: 120_000,
}, async () => {
  const suffix = `${process.pid}-${randomBytes(6).toString("hex")}`;
  const containerName = `tianxing-one-role-pg17-${suffix}`;
  const bootstrapPassword = randomBytes(32).toString("hex");
  const applicationPassword = randomBytes(32).toString("hex");
  let started = false;

  try {
    await runDocker(["image", "inspect", POSTGRES_IMAGE], "postgres_image_missing");
    await runDocker([
      "run",
      "--rm",
      "--detach",
      "--pull=never",
      "--name",
      containerName,
      "--tmpfs",
      "/var/lib/postgresql/data:rw,noexec,nosuid,size=512m",
      "--env",
      "POSTGRES_DB=postgres",
      "--env",
      "POSTGRES_USER=postgres",
      "--env",
      "POSTGRES_PASSWORD",
      "--publish",
      "127.0.0.1::5432",
      POSTGRES_IMAGE,
    ], "postgres_container_start", undefined, {
      ...process.env,
      POSTGRES_PASSWORD: bootstrapPassword,
    });
    started = true;
    await waitForPostgres(containerName);
    await runDocker([
      "exec",
      "--interactive",
      containerName,
      "psql",
      "--set=ON_ERROR_STOP=1",
      "--username=postgres",
      "--dbname=postgres",
    ], "postgres_database_bootstrap", [
      `CREATE ROLE ${ONE_ROLE_CANONICAL_ROLE} WITH`,
      "  LOGIN",
      `  PASSWORD '${applicationPassword}'`,
      "  NOSUPERUSER",
      "  NOCREATEDB",
      "  NOCREATEROLE",
      "  NOINHERIT",
      "  NOREPLICATION",
      "  NOBYPASSRLS;",
      `CREATE DATABASE tianxing OWNER ${ONE_ROLE_CANONICAL_ROLE};`,
      "",
    ].join("\n"));

    const portOutput = await runDocker(
      ["port", containerName, "5432/tcp"],
      "postgres_port_inspection",
    );
    const port = readLoopbackPort(portOutput.stdout);
    const target = localIntegrationTarget(port, applicationPassword);
    assert.equal(target.port, port);
    assert.equal(Number(new URL(target.connectionString).port), target.port);
    const clientConfig = createOneRoleBaselineClientConfig(target);
    const postgresVersion = await readPostgresVersion(clientConfig);
    assert.equal(Number(postgresVersion.split(".")[0]), POSTGRES_MAJOR);

    const build = await verifyCommittedOneRoleBaseline();
    const dryRunEvidence = await executeOneRoleBaselineRun({
      mode: "dry-run",
      target,
      build,
      dependencies: {
        inspect: () => inspectWithNewClient(target),
        openExecutionConnection: async () => {
          const client = new Client(clientConfig);
          await client.connect();
          return Object.freeze({ client, close: () => client.end() });
        },
      },
    });

    assert.equal(dryRunEvidence.status, "pass");
    assert.equal(dryRunEvidence.baseline_id, ONE_ROLE_BASELINE_ID);
    assert.equal(dryRunEvidence.generated_files, ONE_ROLE_SOURCE_COUNT + 1);
    assert.equal(dryRunEvidence.postflight_state, "clean");
    assert.equal(dryRunEvidence.marker, "rolled_back");

    const independentlyVerifiedDryRun = await inspectWithNewClient(target);
    assertOneRoleBaselinePreflight(independentlyVerifiedDryRun, target);
    assert.equal(independentlyVerifiedDryRun.publicObjectCount, 0);
    assert.equal(independentlyVerifiedDryRun.marker, null);

    const applyEvidence = await executeOneRoleBaselineRun({
      mode: "apply",
      target,
      build,
      dependencies: {
        inspect: () => inspectWithNewClient(target),
        openExecutionConnection: async () => {
          const client = new Client(clientConfig);
          await client.connect();
          return Object.freeze({ client, close: () => client.end() });
        },
      },
    });
    assert.equal(applyEvidence.status, "pass");
    assert.equal(applyEvidence.postflight_state, "installed");
    assert.equal(applyEvidence.marker, "installed");
    assert.equal(applyEvidence.verification.role_contract, "verified");
    assert.equal(applyEvidence.verification.member_of_neon_superuser, false);
    assert.equal(applyEvidence.verification.granted_role_count, 0);
    assert.equal(applyEvidence.verification.marker_ownership, "verified");
    assert.ok(applyEvidence.verification.public_object_count > 0);
    assert.equal(applyEvidence.verification.public_wrong_owner_count, 0);
    assert.equal(applyEvidence.verification.rls_not_forced_count, 0);
    assert.equal(applyEvidence.verification.unsafe_security_definer_count, 0);
    assert.equal(applyEvidence.verification.migration_metadata, "absent");
    assert.equal(applyEvidence.verification.stale_dry_run_schema_count, 0);

    const manifestSha256 = createHash("sha256").update(build.manifestJson).digest("hex");
    const independentlyVerifiedApply = await inspectWithNewClient(target);
    assertOneRoleBaselinePostflight({
      state: independentlyVerifiedApply,
      target,
      mode: "apply",
      manifestSha256,
    });
    await assertPrimaryContactLifecycleInvariant(clientConfig);

    process.stdout.write(`${JSON.stringify({
      status: "pass",
      postgres_version: postgresVersion,
      target_port: target.port,
      generated_files: dryRunEvidence.generated_files,
      dry_run: {
        postflight_state: dryRunEvidence.postflight_state,
        marker: dryRunEvidence.marker,
        independent_postflight: "clean",
      },
      apply: {
        postflight_state: applyEvidence.postflight_state,
        marker: applyEvidence.marker,
        independent_postflight: "verified",
        verification: applyEvidence.verification,
      },
      primary_contact_invariant: {
        active: "pass",
        pending_delete: "pass",
        purged: "rejected",
        zero: "rejected",
        multiple: "rejected",
      },
    })}\n`);
  } finally {
    if (started) {
      await runDocker(
        ["rm", "--force", containerName],
        "postgres_container_cleanup",
      );
    }
  }
});

async function assertPrimaryContactLifecycleInvariant(
  clientConfig: ReturnType<typeof createOneRoleBaselineClientConfig>,
): Promise<void> {
  const client = new Client(clientConfig);
  const organizationId = "65000000-0000-4000-8000-000000000001";
  const actorId = "65000000-0000-4000-8000-000000000101";
  const studentId = "65000000-0000-4000-8000-000000000601";
  const guardianId = "65000000-0000-4000-8000-000000000701";
  const alternateGuardianId = "65000000-0000-4000-8000-000000000702";
  const relationshipId = "65000000-0000-4000-8000-000000000801";
  try {
    await client.connect();
    await client.query("BEGIN");
    await setTenantContext(client, organizationId, actorId);
    await client.query(`INSERT INTO identity_users (id,normalized_email,status)
      VALUES ($1,'crm05-primary-invariant@example.invalid','active')`, [actorId]);
    await client.query(`INSERT INTO access_organizations (id,display_name,status,created_by_user_id)
      VALUES ($1,'CRM05 Primary Invariant','active',$2)`, [organizationId, actorId]);
    await client.query(`INSERT INTO crm_guardians (id,organization_id,display_name,status)
      VALUES ($1,$3,'CRM05 Primary Guardian','active'),
             ($2,$3,'CRM05 Alternate Guardian','active')`,
    [guardianId, alternateGuardianId, organizationId]);
    await client.query(`INSERT INTO crm_students (id,organization_id,display_name,status)
      VALUES ($1,$2,'CRM05 Primary Student','active')`, [studentId, organizationId]);
    await client.query(`INSERT INTO crm_student_guardian_relationships
        (id,organization_id,student_id,guardian_id,relationship_type,is_legal_guardian,
         is_primary_contact,is_emergency_contact,is_billing_contact,notification_consent,starts_at)
      VALUES ($1,$2,$3,$4,'other_guardian',true,true,false,false,false,transaction_timestamp())`,
    [relationshipId, organizationId, studentId, guardianId]);
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    await client.query("COMMIT");

    await client.query("BEGIN");
    await setTenantContext(client, organizationId, actorId);
    await client.query(`UPDATE crm_guardians
      SET status='pending_delete',deletion_requested_at=transaction_timestamp(),
          deletion_requested_by_user_id=$2,deletion_reason='record.lifecycle.pending_delete_requested',
          record_version=record_version+1,updated_at=transaction_timestamp()
      WHERE id=$1`, [guardianId, actorId]);
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    await client.query("COMMIT");

    await expectRejectedTransaction(client, organizationId, actorId, async () => {
      await client.query(`UPDATE crm_student_guardian_relationships
        SET ends_at=transaction_timestamp(),ended_by_user_id=$2,end_reason='local invariant test',
            record_version=record_version+1,updated_at=transaction_timestamp()
        WHERE id=$1`, [relationshipId, actorId]);
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    }, "23514", "crm_students_current_primary_contact_check");

    await expectRejectedTransaction(client, organizationId, actorId, async () => {
      await client.query(`INSERT INTO crm_student_guardian_relationships
        (id,organization_id,student_id,guardian_id,relationship_type,is_legal_guardian,
         is_primary_contact,is_emergency_contact,is_billing_contact,notification_consent,starts_at)
        VALUES ('65000000-0000-4000-8000-000000000802',$1,$2,$3,'other_guardian',true,true,
          false,false,false,transaction_timestamp())`,
      [organizationId, studentId, alternateGuardianId]);
    }, "23505", "crm_relationships_one_current_primary_idx");

    await expectRejectedTransaction(client, organizationId, actorId, async () => {
      await client.query(`UPDATE crm_guardians
        SET status='purged',display_name=NULL,email=NULL,phone=NULL,deletion_reason=NULL,
            purge_approved_at=transaction_timestamp(),purge_approved_by_user_id=$2,
            purged_at=transaction_timestamp(),record_version=record_version+1,
            updated_at=transaction_timestamp()
        WHERE id=$1`, [guardianId, actorId]);
    }, "23514", "crm_guardians_purge_current_relationship_check");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error instanceof HarnessError) throw error;
    throw new HarnessError("primary_contact_invariant");
  } finally {
    await client.end().catch(() => {});
  }
}

async function setTenantContext(client: Client, organizationId: string, actorId: string): Promise<void> {
  await client.query("SELECT set_config('app.organization_id',$1,true)", [organizationId]);
  await client.query("SELECT set_config('app.actor_user_id',$1,true)", [actorId]);
}

async function expectRejectedTransaction(
  client: Client,
  organizationId: string,
  actorId: string,
  operation: () => Promise<void>,
  expectedCode: string,
  expectedConstraint: string,
): Promise<void> {
  await client.query("BEGIN");
  await setTenantContext(client, organizationId, actorId);
  try {
    await operation();
    await client.query("COMMIT");
    throw new HarnessError("primary_contact_expected_rejection");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error instanceof HarnessError) throw error;
    const postgres = error as { readonly code?: unknown; readonly constraint?: unknown };
    assert.equal(postgres.code, expectedCode);
    assert.equal(postgres.constraint, expectedConstraint);
  }
}

async function inspectWithNewClient(
  target: OneRoleBaselineTarget,
): Promise<OneRoleBaselineDatabaseState> {
  const client = new Client(createOneRoleBaselineClientConfig(target));
  let connected = false;
  try {
    await client.connect();
    connected = true;
    return await inspectOneRoleBaselineDatabase(client);
  } catch {
    throw new HarnessError("postgres_state_inspection");
  } finally {
    if (connected) await client.end().catch(() => {});
  }
}

async function readPostgresVersion(
  clientConfig: ReturnType<typeof createOneRoleBaselineClientConfig>,
): Promise<string> {
  const client = new Client(clientConfig);
  let connected = false;
  try {
    await client.connect();
    connected = true;
    const result = await client.query<{ version: string }>(
      "SELECT current_setting('server_version') AS version",
    );
    const version = result.rows[0]?.version;
    if (!version) throw new HarnessError("postgres_version_inspection");
    return version;
  } catch (error) {
    if (error instanceof HarnessError) throw error;
    throw new HarnessError("postgres_version_inspection");
  } finally {
    if (connected) await client.end().catch(() => {});
  }
}

function localIntegrationTarget(port: number, password: string): OneRoleBaselineTarget {
  return Object.freeze({
    connectionString: `postgresql://${ONE_ROLE_CANONICAL_ROLE}:${password}@127.0.0.1:${port}/tianxing`,
    host: "127.0.0.1",
    port,
    database: "tianxing",
    user: ONE_ROLE_CANONICAL_ROLE,
    ssl: false,
  });
}

async function waitForPostgres(containerName: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const probe = await runDocker([
      "exec",
      containerName,
      "pg_isready",
      "--host=127.0.0.1",
      "--username=postgres",
      "--dbname=postgres",
    ], "postgres_readiness", undefined, process.env, true);
    if (probe.exitCode === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new HarnessError("postgres_readiness_timeout");
}

function readLoopbackPort(output: string): number {
  const match = /^127\.0\.0\.1:([0-9]+)\s*$/.exec(output);
  const port = Number(match?.[1]);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new HarnessError("postgres_port_inspection");
  }
  return port;
}

class HarnessError extends Error {
  readonly code = "ONE_ROLE_POSTGRESQL_HARNESS_FAILED" as const;
  readonly stage: string;

  constructor(stage: string) {
    super(`One-role PostgreSQL integration harness failed at ${stage}.`);
    this.name = "HarnessError";
    this.stage = stage;
  }
}

async function runDocker(
  arguments_: readonly string[],
  failureStage: string,
  input?: string,
  environment: NodeJS.ProcessEnv = process.env,
  allowFailure = false,
): Promise<Readonly<{ exitCode: number; stdout: string }>> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", arguments_, {
      cwd: process.cwd(),
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", () => {});
    child.once("error", () => reject(new HarnessError(failureStage)));
    child.once("close", (code) => {
      const exitCode = code ?? 1;
      if (exitCode !== 0 && !allowFailure) {
        reject(new HarnessError(failureStage));
        return;
      }
      resolve(Object.freeze({ exitCode, stdout }));
    });
    child.stdin.end(input);
  });
}
