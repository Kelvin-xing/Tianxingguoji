import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { Client } from "pg";

import {
  LOCAL_SYNTHETIC_ORGANIZATION,
  LOCAL_SYNTHETIC_PRINCIPALS,
} from "../../modules/identity/server.ts";
import { loadLocalSyntheticConfig } from "../../lib/runtime/local-synthetic-config.ts";
import { readLocalMigrationTarget } from "./run-local-migrations.ts";

const LOCAL_IDENTITY_USER = "tianxing_local_identity";
const LOCAL_IDENTITY_PASSWORD = "tianxing-local-identity-only";

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

export interface LocalIdentitySeedTarget {
  readonly ownerConnectionString: string;
  readonly runtimeConnectionString: string;
}

export class LocalIdentitySeedSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalIdentitySeedSafetyError";
  }
}

export function readLocalIdentitySeedTarget(
  environment: RuntimeEnvironment = process.env,
): LocalIdentitySeedTarget {
  const owner = readLocalMigrationTarget(environment);
  const runtime = loadLocalSyntheticConfig(environment).database.identityConnectionString;
  const runtimeUrl = new URL(runtime);
  if (
    runtimeUrl.username !== LOCAL_IDENTITY_USER ||
    runtimeUrl.password !== LOCAL_IDENTITY_PASSWORD ||
    runtimeUrl.host !== `${owner.host}:${owner.port}` ||
    runtimeUrl.pathname !== `/${owner.database}`
  ) {
    throw new LocalIdentitySeedSafetyError(
      "Local identity seed requires the fixed loopback runtime identity target.",
    );
  }
  return Object.freeze({
    ownerConnectionString: owner.connectionString,
    runtimeConnectionString: runtime,
  });
}

export async function seedLocalSyntheticIdentity(
  target: LocalIdentitySeedTarget,
): Promise<Readonly<{ users: number; memberships: number; roles: number }>> {
  const owner = new Client({
    connectionString: target.ownerConnectionString,
    application_name: "tianxing-local-identity-seed",
    connectionTimeoutMillis: 3_000,
    query_timeout: 5_000,
    ssl: false,
  });
  await owner.connect();
  try {
    await assertOwnerConnection(owner);
    await owner.query("BEGIN");
    let counts: Readonly<{ users: number; memberships: number; roles: number }>;
    try {
      await provisionRuntimeRole(owner);
      await seedPrincipals(owner);
      counts = await verifySeedAsOwner(owner);
      await owner.query("COMMIT");
    } catch (error) {
      await owner.query("ROLLBACK");
      throw error;
    }
    await verifyRuntimeBoundary(target.runtimeConnectionString);
    return counts;
  } finally {
    await owner.end();
  }
}

async function assertOwnerConnection(client: Client): Promise<void> {
  const result = await client.query<{
    database_name: string;
    user_name: string;
    rolsuper: boolean;
    rolcreaterole: boolean;
  }>(
    `SELECT current_database() AS database_name,
            current_user AS user_name,
            role.rolsuper,
            role.rolcreaterole
       FROM pg_roles AS role
      WHERE role.rolname = current_user`,
  );
  const row = result.rows[0];
  if (
    row?.database_name !== "tianxing" ||
    row.user_name !== "tianxing_migration" ||
    !row.rolsuper ||
    !row.rolcreaterole
  ) {
    throw new LocalIdentitySeedSafetyError(
      "Connected database identity is not the approved local owner.",
    );
  }
}

async function provisionRuntimeRole(client: Client): Promise<void> {
  const role = await client.query<{ exists: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists",
    [LOCAL_IDENTITY_USER],
  );
  if (role.rows[0]?.exists) {
    await client.query(
      `ALTER ROLE tianxing_local_identity WITH
         LOGIN PASSWORD 'tianxing-local-identity-only'
         NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
    );
  } else {
    await client.query(
      `CREATE ROLE tianxing_local_identity WITH
         LOGIN PASSWORD 'tianxing-local-identity-only'
         NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
    );
  }

  await client.query("REVOKE ALL ON DATABASE tianxing FROM tianxing_local_identity");
  await client.query("GRANT CONNECT ON DATABASE tianxing TO tianxing_local_identity");
  await client.query("REVOKE ALL ON SCHEMA public FROM tianxing_local_identity");
  await client.query("GRANT USAGE ON SCHEMA public TO tianxing_local_identity");
  await client.query(
    "REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM tianxing_local_identity",
  );
  await client.query(
    `GRANT SELECT ON TABLE
       identity_users,
       access_organizations,
       access_organization_memberships,
       access_role_bindings
     TO tianxing_local_identity`,
  );
  await client.query(
    `GRANT SELECT, INSERT, UPDATE ON TABLE identity_sessions
     TO tianxing_local_identity`,
  );

  for (const table of [
    "access_organization_memberships",
    "access_role_bindings",
    "identity_sessions",
  ]) {
    await client.query(`DROP POLICY IF EXISTS tianxing_local_identity_boundary ON ${table}`);
    await client.query(
      `CREATE POLICY tianxing_local_identity_boundary ON ${table}
         FOR ALL TO tianxing_local_identity
         USING (organization_id::text = current_setting('app.organization_id', true))
         WITH CHECK (organization_id::text = current_setting('app.organization_id', true))`,
    );
  }
}

async function seedPrincipals(client: Client): Promise<void> {
  for (const principal of LOCAL_SYNTHETIC_PRINCIPALS) {
    await client.query(
      `INSERT INTO identity_users (id, normalized_email, status)
       VALUES ($1, $2, 'active')
       ON CONFLICT (id) DO NOTHING`,
      [principal.userId, principal.normalizedEmail],
    );
  }

  const founder = LOCAL_SYNTHETIC_PRINCIPALS[0];
  await client.query(
    `INSERT INTO access_organizations (
       id, display_name, status, created_by_user_id
     ) VALUES ($1, $2, 'active', $3)
     ON CONFLICT (id) DO NOTHING`,
    [
      LOCAL_SYNTHETIC_ORGANIZATION.id,
      LOCAL_SYNTHETIC_ORGANIZATION.displayName,
      founder.userId,
    ],
  );

  for (const principal of LOCAL_SYNTHETIC_PRINCIPALS) {
    await client.query(
      `INSERT INTO access_organization_memberships (
         id, organization_id, user_id, status, created_by_user_id
       ) VALUES ($1, $2, $3, 'active', $4)
       ON CONFLICT (id) DO NOTHING`,
      [
        principal.membershipId,
        LOCAL_SYNTHETIC_ORGANIZATION.id,
        principal.userId,
        founder.userId,
      ],
    );
    await client.query(
      `INSERT INTO access_role_bindings (
         id, organization_id, membership_id, user_id, role, status, created_by_user_id
       ) VALUES ($1, $2, $3, $4, $5, 'active', $6)
       ON CONFLICT (id) DO NOTHING`,
      [
        principal.roleBindingId,
        LOCAL_SYNTHETIC_ORGANIZATION.id,
        principal.membershipId,
        principal.userId,
        principal.role,
        founder.userId,
      ],
    );
  }
}

async function verifySeedAsOwner(
  client: Client,
): Promise<Readonly<{ users: number; memberships: number; roles: number }>> {
  const result = await client.query<{
    user_id: string;
    normalized_email: string;
    user_status: string;
    session_version: string | number;
    organization_id: string;
    display_name: string;
    organization_status: string;
    membership_id: string;
    membership_status: string;
    role_binding_id: string;
    role: string;
    role_status: string;
  }>(
    `SELECT identity_user.id AS user_id,
            identity_user.normalized_email,
            identity_user.status AS user_status,
            identity_user.session_version,
            organization.id AS organization_id,
            organization.display_name,
            organization.status AS organization_status,
            membership.id AS membership_id,
            membership.status AS membership_status,
            role_binding.id AS role_binding_id,
            role_binding.role,
            role_binding.status AS role_status
       FROM identity_users AS identity_user
       JOIN access_organization_memberships AS membership
         ON membership.user_id = identity_user.id
       JOIN access_organizations AS organization
         ON organization.id = membership.organization_id
       JOIN access_role_bindings AS role_binding
         ON role_binding.membership_id = membership.id
        AND role_binding.organization_id = membership.organization_id
        AND role_binding.user_id = membership.user_id
      WHERE organization.id = $1
      ORDER BY role_binding.role`,
    [LOCAL_SYNTHETIC_ORGANIZATION.id],
  );

  if (result.rows.length !== LOCAL_SYNTHETIC_PRINCIPALS.length) {
    throw new LocalIdentitySeedSafetyError("Local identity seed row count is inconsistent.");
  }
  for (const principal of LOCAL_SYNTHETIC_PRINCIPALS) {
    const row = result.rows.find(({ role }) => role === principal.role);
    if (
      !row ||
      row.user_id !== principal.userId ||
      row.normalized_email !== principal.normalizedEmail ||
      row.user_status !== "active" ||
      Number(row.session_version) !== 1 ||
      row.organization_id !== LOCAL_SYNTHETIC_ORGANIZATION.id ||
      row.display_name !== LOCAL_SYNTHETIC_ORGANIZATION.displayName ||
      row.organization_status !== "active" ||
      row.membership_id !== principal.membershipId ||
      row.membership_status !== "active" ||
      row.role_binding_id !== principal.roleBindingId ||
      row.role_status !== "active"
    ) {
      throw new LocalIdentitySeedSafetyError("Local identity seed is inconsistent.");
    }
  }
  return Object.freeze({ users: 5, memberships: 5, roles: 5 });
}

async function verifyRuntimeBoundary(connectionString: string): Promise<void> {
  const runtime = new Client({
    connectionString,
    application_name: "tianxing-local-identity-seed-verifier",
    connectionTimeoutMillis: 3_000,
    query_timeout: 5_000,
    ssl: false,
  });
  await runtime.connect();
  try {
    const privileges = await runtime.query<{
      can_read_users: boolean;
      can_write_users: boolean;
      can_read_sessions: boolean;
      can_write_sessions: boolean;
    }>(
      `SELECT
         has_table_privilege(current_user, 'identity_users', 'SELECT') AS can_read_users,
         has_table_privilege(current_user, 'identity_users', 'INSERT,UPDATE,DELETE') AS can_write_users,
         has_table_privilege(current_user, 'identity_sessions', 'SELECT') AS can_read_sessions,
         has_table_privilege(current_user, 'identity_sessions', 'INSERT,UPDATE') AS can_write_sessions`,
    );
    const grant = privileges.rows[0];
    if (
      !grant?.can_read_users ||
      grant.can_write_users ||
      !grant.can_read_sessions ||
      !grant.can_write_sessions
    ) {
      throw new LocalIdentitySeedSafetyError("Local identity runtime privileges are inconsistent.");
    }

    await runtime.query("BEGIN");
    await runtime.query("SELECT set_config('app.organization_id', $1, true)", [
      LOCAL_SYNTHETIC_ORGANIZATION.id,
    ]);
    const visible = await runtime.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM access_organization_memberships
        WHERE organization_id = $1`,
      [LOCAL_SYNTHETIC_ORGANIZATION.id],
    );
    await runtime.query("ROLLBACK");
    if (Number(visible.rows[0]?.count) !== LOCAL_SYNTHETIC_PRINCIPALS.length) {
      throw new LocalIdentitySeedSafetyError("Local identity runtime RLS boundary is inconsistent.");
    }
  } finally {
    await runtime.end();
  }
}

async function runCli(environment: RuntimeEnvironment): Promise<void> {
  const target = readLocalIdentitySeedTarget(environment);
  const result = await seedLocalSyntheticIdentity(target);
  process.stdout.write(
    `${JSON.stringify({ ...result, organization: 1, status: "pass" }, null, 2)}\n`,
  );
}

const isMainModule =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  runCli(process.env).catch((error: unknown) => {
    const unsafeMessage = error instanceof Error ? error.message : "Unknown local identity seed failure.";
    const secrets = [
      process.env.MIGRATION_DATABASE_URL ?? "",
      process.env.LOCAL_SYNTHETIC_IDENTITY_DATABASE_URL ?? "",
    ].filter(Boolean);
    const safeMessage = secrets.reduce(
      (message, secret) => message.replaceAll(secret, "[redacted]"),
      unsafeMessage,
    );
    process.stderr.write(`${safeMessage}\n`);
    process.exitCode = 1;
  });
}
