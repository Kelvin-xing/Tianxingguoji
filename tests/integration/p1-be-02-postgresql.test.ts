import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import test from "node:test";

import { Client, Pool } from "pg";

import {
  ONE_ROLE_SOURCE_COUNT,
  verifyCommittedOneRoleBaseline,
  type OneRoleGeneratedFile,
} from "../../scripts/db/generate-one-role-baseline.ts";

const POSTGRES_IMAGE = "postgres:17.10-alpine3.24";
const APP_ROLE = "tianxing_app";
const IDS = Object.freeze({
  organization: "22000000-0000-4000-8000-000000000001",
  disabledOrganization: "22000000-0000-4000-8000-000000000002",
  multiUser: "22000000-0000-4000-8000-000000000010",
  multiMembership: "22000000-0000-4000-8000-000000000011",
  contractorUser: "22000000-0000-4000-8000-000000000020",
  contractorMembership: "22000000-0000-4000-8000-000000000021",
  founderOnlyUser: "22000000-0000-4000-8000-000000000030",
  founderOnlyMembership: "22000000-0000-4000-8000-000000000031",
  partTimeUser: "22000000-0000-4000-8000-000000000040",
  partTimeMembership: "22000000-0000-4000-8000-000000000041",
  founderRole: "22000000-0000-4000-8000-000000000101",
  adminRole: "22000000-0000-4000-8000-000000000102",
  advisorRole: "22000000-0000-4000-8000-000000000103",
  contractorRole: "22000000-0000-4000-8000-000000000104",
  founderOnlyRole: "22000000-0000-4000-8000-000000000105",
  collaborator: "22000000-0000-4000-8000-000000000201",
  scopeGrant: "22000000-0000-4000-8000-000000000202",
  invite: "22000000-0000-4000-8000-000000000301",
  session: "22000000-0000-4000-8000-000000000401",
  sessionAfterReauth: "22000000-0000-4000-8000-000000000402",
  invalidSession: "22000000-0000-4000-8000-000000000403",
  audit: "22000000-0000-4000-8000-000000000501",
  auditResource: "22000000-0000-4000-8000-000000000502",
});

test("P1-BE-02 PostgreSQL 17 gate: Identity + Access boundaries", {
  timeout: 180_000,
}, async () => {
  const suffix = `${process.pid}-${randomBytes(6).toString("hex")}`;
  const containerName = `tianxing-p1-be-02-pg17-${suffix}`;
  const bootstrapPassword = randomBytes(32).toString("hex");
  const applicationPassword = randomBytes(32).toString("hex");
  let started = false;
  let application: Pool | undefined;
  let admin: Pool | undefined;

  try {
    await runDocker(["image", "inspect", POSTGRES_IMAGE], "postgres_image_missing");
    await runDocker([
      "run", "--rm", "--detach", "--pull=never", "--name", containerName,
      "--tmpfs", "/var/lib/postgresql/data:rw,noexec,nosuid,size=512m",
      "--env", "POSTGRES_DB=postgres", "--env", "POSTGRES_USER=postgres",
      "--env", "POSTGRES_PASSWORD", "--publish", "127.0.0.1::5432", POSTGRES_IMAGE,
    ], "postgres_container_start", undefined, { ...process.env, POSTGRES_PASSWORD: bootstrapPassword });
    started = true;
    await waitForPostgres(containerName);
    await bootstrapDatabases(containerName, applicationPassword);
    const port = readLoopbackPort((await runDocker(
      ["port", containerName, "5432/tcp"], "postgres_port_inspection",
    )).stdout);
    const applicationUrl = databaseUrl(APP_ROLE, applicationPassword, port, "tianxing");
    const emptyApplicationUrl = databaseUrl(APP_ROLE, applicationPassword, port, "tianxing_empty");
    const adminUrl = databaseUrl("postgres", bootstrapPassword, port, "tianxing");
    const build = await verifyCommittedOneRoleBaseline();
    assert.equal(build.manifest.source_migrations.length, ONE_ROLE_SOURCE_COUNT);
    const identityMigrationIndex = build.files.findIndex(({ name }) =>
      name === "037_202608260020_038_expand_identity_access_boundaries.sql");
    assert.notEqual(identityMigrationIndex, -1);
    assert.equal(build.files[identityMigrationIndex]?.name,
      "037_202608260020_038_expand_identity_access_boundaries.sql");
    await applyFiles(applicationUrl, build.files);
    await applyFiles(emptyApplicationUrl, build.files);
    await assertEmptyReplayContract(emptyApplicationUrl);

    application = new Pool({ connectionString: applicationUrl, max: 4 });
    admin = new Pool({ connectionString: adminUrl, max: 2 });
    await seedFixture(admin);
    await assertIdentitySessionContract(application, admin);
    await assertAccessResolutionAndRevocation(application, admin);
    await assertRoleAndProfileConstraints(admin);
    await assertInviteAndScopeGrantBoundaries(admin, application);
    await assertRlsIsolation(application);
    await assertAuditRollback(admin);
  } finally {
    await application?.end().catch(() => undefined);
    await admin?.end().catch(() => undefined);
    if (started) {
      await runDocker(["rm", "--force", containerName], "postgres_container_cleanup")
        .catch(() => undefined);
    }
  }
});

async function seedFixture(admin: Pool): Promise<void> {
  await admin.query(`
    INSERT INTO access_organizations (id, display_name, status)
    VALUES ($1, 'P1 BE-02', 'active'), ($2, 'P1 BE-02 disabled', 'disabled')`, [
    IDS.organization, IDS.disabledOrganization,
  ]);
  await admin.query(`
    INSERT INTO identity_users (id, normalized_email, status, activated_at) VALUES
      ($1, 'p1-be-02-multi@example.invalid', 'active', now()),
      ($2, 'p1-be-02-contractor@example.invalid', 'active', now()),
      ($3, 'p1-be-02-founder@example.invalid', 'active', now()),
      ($4, 'p1-be-02-part-time@example.invalid', 'active', now())`, [
    IDS.multiUser, IDS.contractorUser, IDS.founderOnlyUser, IDS.partTimeUser,
  ]);
  await admin.query(`
    INSERT INTO access_organization_memberships (id, organization_id, user_id, status, activated_at)
    VALUES ($1, $2, $3, 'active', now()), ($4, $2, $5, 'active', now()),
           ($6, $2, $7, 'active', now()), ($8, $2, $9, 'active', now())`, [
    IDS.multiMembership, IDS.organization, IDS.multiUser,
    IDS.contractorMembership, IDS.contractorUser,
    IDS.founderOnlyMembership, IDS.founderOnlyUser,
    IDS.partTimeMembership, IDS.partTimeUser,
  ]);
  await admin.query(`
    INSERT INTO access_employee_profiles
      (membership_id, organization_id, display_name, employment_type)
    VALUES ($1, $2, 'Founder Admin Advisor', 'FULL_TIME'),
           ($3, $2, 'Contractor', 'PART_TIME'),
           ($4, $2, 'Founder Only', 'FULL_TIME'),
           ($5, $2, 'Part Time Employee', 'PART_TIME')`, [
    IDS.multiMembership, IDS.organization, IDS.contractorMembership,
    IDS.founderOnlyMembership, IDS.partTimeMembership,
  ]);
  await admin.query(`
    INSERT INTO access_role_bindings
      (id, organization_id, membership_id, user_id, role, status)
    VALUES ($1, $2, $3, $4, 'founder', 'active'),
           ($5, $2, $3, $4, 'admin', 'active'),
           ($6, $2, $3, $4, 'advisor', 'active'),
           ($7, $2, $8, $9, 'contractor', 'active'),
           ($10, $2, $11, $12, 'founder', 'active')`, [
    IDS.founderRole, IDS.organization, IDS.multiMembership, IDS.multiUser,
    IDS.adminRole, IDS.advisorRole, IDS.contractorRole, IDS.contractorMembership,
    IDS.contractorUser, IDS.founderOnlyRole, IDS.founderOnlyMembership,
    IDS.founderOnlyUser,
  ]);
}

async function assertIdentitySessionContract(application: Pool, admin: Pool): Promise<void> {
  const secret = Buffer.alloc(32, 0xab);
  await admin.query(`INSERT INTO identity_sessions
    (id, user_id, organization_id, membership_id, secret_hash, captured_session_version,
     session_slot, status, provider_token_ciphertext, provider_token_key_version,
     last_seen_at, idle_expires_at, absolute_expires_at)
     VALUES ($1, $2, NULL, NULL, $3, 1, 1, 'active', decode('aa','hex'), 'v1',
            now(), now() + interval '8 hours', now() + interval '24 hours')`,
     [IDS.session, IDS.multiUser, secret]);
  const applicationClient = await application.connect();
  try {
    await applicationClient.query("BEGIN");
    const hiddenWithoutLocator = await applicationClient.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM identity_sessions WHERE id = $1",
      [IDS.session],
    );
    assert.equal(hiddenWithoutLocator.rows[0]?.count, 0);
    const allowed = await applicationClient.query<PrincipalRow>(
      "SELECT * FROM identity_resolve_session_principal($1, now(), false)",
      [secret],
    );
    assert.deepEqual(allowed.rows[0], {
      allowed: true, user_id: IDS.multiUser, session_id: IDS.session,
      organization_id: null, membership_id: null,
      captured_session_version: "1", reauthenticated_at: null, denial_code: null,
    });
    const locatorAfterResolve = await applicationClient.query<{ locator: string | null }>(
      "SELECT nullif(current_setting('app.identity_session_secret_hash', true), '') AS locator",
    );
    assert.equal(locatorAfterResolve.rows[0]?.locator, null);
    const hiddenAfterResolve = await applicationClient.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM identity_sessions WHERE id = $1",
      [IDS.session],
    );
    assert.equal(hiddenAfterResolve.rows[0]?.count, 0);
    await applicationClient.query("COMMIT");
  } catch (error) {
    await applicationClient.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    applicationClient.release();
  }
  const sensitive = await application.query<PrincipalRow>(
    "SELECT * FROM identity_resolve_session_principal($1, now(), true)", [secret]);
  assert.equal(sensitive.rows[0]?.denial_code, "SENSITIVE_REAUTH_REQUIRED");

  await admin.query(`INSERT INTO identity_sessions
    (id, user_id, organization_id, membership_id, secret_hash, captured_session_version,
     session_slot, status, provider_token_ciphertext, provider_token_key_version,
     last_seen_at, idle_expires_at, absolute_expires_at)
    VALUES ($1, $2, NULL, NULL, $3, 1, 2, 'active', decode('aa','hex'), 'v1',
            now(), now() + interval '8 hours', now() + interval '24 hours')`,
     [IDS.sessionAfterReauth, IDS.founderOnlyUser, Buffer.alloc(32, 0xac)]);
  await admin.query(`UPDATE identity_users
    SET status='disabled', session_version=session_version+1, disabled_at=now(),
        disable_reason_code='test', record_version=record_version+1, updated_at=now()
    WHERE id=$1`, [IDS.founderOnlyUser]);
  const denied = await application.query<PrincipalRow>(
    "SELECT * FROM identity_resolve_session_principal($1, now(), false)", [Buffer.alloc(32, 0xac)]);
  assert.equal(denied.rows[0]?.denial_code, "USER_DISABLED");

  await assert.rejects(admin.query(`INSERT INTO identity_sessions
    (id, user_id, organization_id, membership_id, secret_hash, captured_session_version,
     session_slot, status, provider_token_ciphertext, provider_token_key_version,
     last_seen_at, idle_expires_at, absolute_expires_at)
    VALUES ($1, $2, NULL, NULL, $3, 1, 3, 'active', decode('aa','hex'), 'v1',
            now(), now() + interval '9 hours', now() + interval '24 hours')`,
  [IDS.invalidSession, IDS.contractorUser, Buffer.alloc(32, 0xad)]));
}

async function assertAccessResolutionAndRevocation(application: Pool, admin: Pool): Promise<void> {
  const initial = await resolveAccessContext(application);
  assert.deepEqual(initial.map(({ role }) => role), ["founder", "admin", "advisor"]);
  await admin.query("UPDATE access_role_bindings SET status='revoked', record_version=record_version+1, updated_at=now() WHERE id=$1", [IDS.adminRole]);
  const afterRoleRevoke = await resolveAccessContext(application);
  assert.deepEqual(afterRoleRevoke.map(({ role }) => role), ["founder", "advisor"]);
  await admin.query("UPDATE access_organization_memberships SET status='disabled', record_version=record_version+1, updated_at=now(), disabled_at=now(), disable_reason_code='test' WHERE id=$1", [IDS.multiMembership]);
  const afterMembershipRevoke = await resolveAccessContext(application);
  assert.equal(afterMembershipRevoke.length, 0);
}

async function resolveAccessContext(application: Pool): Promise<readonly AccessRow[]> {
  const client = await application.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.organization_id', $1, true)", [IDS.organization]);
    const result = await client.query<AccessRow>(
      "SELECT * FROM access_resolve_workspace_context($1, $2, $3)",
      [IDS.multiUser, IDS.organization, IDS.multiMembership],
    );
    await client.query("COMMIT");
    const contextAfterCommit = await client.query<{ organization_id: string | null }>(
      "SELECT nullif(current_setting('app.organization_id', true), '') AS organization_id",
    );
    assert.equal(contextAfterCommit.rows[0]?.organization_id, null);
    return result.rows;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function assertRoleAndProfileConstraints(admin: Pool): Promise<void> {
  await assert.rejects(admin.query(`INSERT INTO access_role_bindings
    (id, organization_id, membership_id, user_id, role, status)
    VALUES ('22000000-0000-4000-8000-000000000106', $1, $2, $3, 'contractor', 'active')`,
  [IDS.organization, IDS.founderOnlyMembership, IDS.founderOnlyUser]));
  await assert.rejects(admin.query(`INSERT INTO access_role_bindings
    (id, organization_id, membership_id, user_id, role, status)
    VALUES ('22000000-0000-4000-8000-000000000107', $1, $2, $3, 'data_reviewer', 'active')`,
  [IDS.organization, IDS.founderOnlyMembership, IDS.founderOnlyUser]));
  await assert.rejects(admin.query("UPDATE access_role_bindings SET status='revoked', record_version=record_version+1, updated_at=now() WHERE id=$1", [IDS.founderOnlyRole]));
  await assert.rejects(admin.query(`INSERT INTO access_role_bindings
    (id, organization_id, membership_id, user_id, role, status)
    VALUES ('22000000-0000-4000-8000-000000000108', $1, $2, $3, 'founder', 'active')`,
  [IDS.organization, IDS.partTimeMembership, IDS.partTimeUser]));
  await assert.rejects(admin.query("DELETE FROM access_employee_profiles WHERE membership_id=$1", [IDS.contractorMembership]));
}

async function assertInviteAndScopeGrantBoundaries(admin: Pool, application: Pool): Promise<void> {
  await admin.query(`INSERT INTO identity_invites
    (id, organization_id, target_user_id, invited_by_user_id, requested_role, secret_hash,
     status, expires_at)
    VALUES ($1, $2, $3, $4, NULL, $5, 'created', now() + interval '72 hours')`,
  [IDS.invite, IDS.organization, IDS.contractorUser, IDS.founderOnlyUser,
    Buffer.alloc(32, 0xbb)]);
  await admin.query("UPDATE identity_invites SET status='redeemed', consumed_at=now(), record_version=record_version+1, updated_at=now() WHERE id=$1", [IDS.invite]);
  await assert.rejects(admin.query("UPDATE identity_invites SET status='revoked', revoked_at=now(), revoke_reason='late' WHERE id=$1", [IDS.invite]));

  await admin.query(`INSERT INTO access_case_collaborators
    (id, organization_id, case_id, user_id, membership_id, advisor_role_binding_id,
     status, starts_at, expires_at, granted_by_user_id)
    VALUES ($1, $2, '22000000-0000-4000-8000-000000000601', $3, $4, $5,
            'active', now(), now() + interval '1 hour', $6)`,
  [IDS.collaborator, IDS.organization, IDS.multiUser, IDS.multiMembership,
    IDS.advisorRole, IDS.founderOnlyUser]);
  await admin.query(`INSERT INTO access_scope_grants
    (id, organization_id, case_id, collaborator_id, scope, capability, status,
     starts_at, expires_at, requested_by_user_id)
    VALUES ($1, $2, '22000000-0000-4000-8000-000000000601', $3, 'case_summary', 'view',
            'active', now(), now() + interval '30 minutes', $4)`,
  [IDS.scopeGrant, IDS.organization, IDS.collaborator, IDS.multiUser]);
  await assert.rejects(admin.query(`INSERT INTO access_scope_grants
    (id, organization_id, case_id, collaborator_id, scope, capability, status,
     starts_at, expires_at, requested_by_user_id)
    VALUES ('22000000-0000-4000-8000-000000000203', $1,
            '22000000-0000-4000-8000-000000000601', $2, 'case_summary', 'comment',
            'pending_approval', now(), now() + interval '1 hour', $3)`,
  [IDS.organization, IDS.collaborator, IDS.multiUser]));
  await assert.rejects(admin.query(`INSERT INTO access_scope_grants
    (id, organization_id, case_id, collaborator_id, scope, capability, status,
     starts_at, expires_at, requested_by_user_id)
    VALUES ('22000000-0000-4000-8000-000000000204', $1,
            '22000000-0000-4000-8000-000000000601', $2, 'education_profile', 'view',
            'active', now(), now() + interval '2 hours', $3)`,
  [IDS.organization, IDS.collaborator, IDS.multiUser]));
  const client = await application.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.organization_id', $1, true)", [IDS.organization]);
    const rows = await client.query<{ count: string }>(
      "SELECT count(*) FROM access_scope_grants WHERE organization_id=$1",
      [IDS.organization],
    );
    assert.equal(rows.rows[0]?.count, "1");
    await client.query("COMMIT");
    const contextAfterCommit = await client.query<{ organization_id: string | null }>(
      "SELECT nullif(current_setting('app.organization_id', true), '') AS organization_id",
    );
    assert.equal(contextAfterCommit.rows[0]?.organization_id, null);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function assertRlsIsolation(application: Pool): Promise<void> {
  const left = await application.connect();
  const right = await application.connect();
  try {
    await Promise.all([left.query("BEGIN"), right.query("BEGIN")]);
    await Promise.all([
      left.query("SELECT set_config('app.organization_id',$1,true)", [IDS.organization]),
      right.query("SELECT set_config('app.organization_id',$1,true)", [IDS.disabledOrganization]),
    ]);
    const [leftRows, rightRows] = await Promise.all([
      left.query("SELECT membership_id FROM access_employee_profiles"),
      right.query("SELECT membership_id FROM access_employee_profiles"),
    ]);
    assert.equal(leftRows.rows.length, 4);
    assert.equal(rightRows.rows.length, 0);
  } finally {
    await Promise.all([left.query("ROLLBACK"), right.query("ROLLBACK")]);
    left.release();
    right.release();
  }
}

async function assertAuditRollback(admin: Pool): Promise<void> {
  const client = await admin.connect();
  try {
    await client.query("BEGIN");
    await client.query(`INSERT INTO identity_invites
      (id, organization_id, target_user_id, invited_by_user_id, requested_role, secret_hash,
       status, expires_at)
      VALUES ('22000000-0000-4000-8000-000000000302', $1, $2, $3, NULL,
              decode(repeat('bc', 32), 'hex'), 'created', now() + interval '72 hours')`,
    [IDS.organization, IDS.contractorUser, IDS.founderOnlyUser]);
    await assert.rejects(client.query(`INSERT INTO audit_events
      (id, organization_id, actor_user_id, actor_kind, event_type, event_version, action,
       resource_type, resource_id, outcome, request_id, metadata)
      VALUES ($1, $2, $3, 'user', 'p1_be_02.rollback', 1, 'create', 'Invite', $4,
              'succeeded', 'p1-be-02-rollback', '{"unsafe":{"nested":true}}'::jsonb)`,
    [IDS.audit, IDS.organization, IDS.founderOnlyUser, IDS.auditResource]));
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
  const count = await admin.query<{ count: string }>(
    "SELECT count(*) FROM identity_invites WHERE id='22000000-0000-4000-8000-000000000302'");
  assert.equal(count.rows[0]?.count, "0");
}

async function assertEmptyReplayContract(connectionString: string): Promise<void> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const result = await client.query<{ count: string }>("SELECT count(*) FROM identity_users");
    assert.equal(result.rows[0]?.count, "0");
  } finally {
    await client.end();
  }
}

type PrincipalRow = {
  allowed: boolean;
  user_id: string | null;
  session_id: string | null;
  organization_id: string | null;
  membership_id: string | null;
  captured_session_version: string | null;
  reauthenticated_at: string | null;
  denial_code: string | null;
};

type AccessRow = { role: string };

async function applyFiles(connectionString: string, files: readonly OneRoleGeneratedFile[]): Promise<void> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query("BEGIN");
    for (const file of files) {
      try {
        await client.query(file.contents);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${file.name}: ${message}`, { cause: error });
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

async function bootstrapDatabases(containerName: string, applicationPassword: string): Promise<void> {
  await runDocker([
    "exec", "--interactive", containerName, "psql", "--set=ON_ERROR_STOP=1",
    "--username=postgres", "--dbname=postgres",
  ], "postgres_database_bootstrap", [
    `CREATE ROLE ${APP_ROLE} WITH LOGIN PASSWORD '${applicationPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;`,
    `CREATE DATABASE tianxing OWNER ${APP_ROLE};`,
    `CREATE DATABASE tianxing_empty OWNER ${APP_ROLE};`,
    "",
  ].join("\n"));
}

async function waitForPostgres(containerName: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await runDocker(["exec", containerName, "pg_isready", "--username=postgres",
        "--host=127.0.0.1", "--dbname=postgres"], "postgres_readiness");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error("P1-BE-02 PostgreSQL readiness failed.");
}

function databaseUrl(user: string, password: string, port: number, database: string): string {
  const url = new URL("postgresql://127.0.0.1");
  url.username = user;
  url.password = password;
  url.port = String(port);
  url.pathname = `/${database}`;
  return url.toString();
}

function readLoopbackPort(output: string): number {
  const match = output.trim().match(/^127\.0\.0\.1:(\d+)$/m);
  const port = Number(match?.[1]);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("P1-BE-02 PostgreSQL loopback port inspection failed.");
  }
  return port;
}

function runDocker(
  arguments_: readonly string[],
  stage: string,
  input?: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", arguments_, { env: environment, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.on("error", () => reject(new Error(`P1-BE-02 Docker stage failed: ${stage}.`)));
    child.on("close", (code) => code === 0
      ? resolve({ stdout })
      : reject(new Error(`P1-BE-02 Docker stage failed: ${stage}.`)));
    child.stdin.end(input);
  });
}
