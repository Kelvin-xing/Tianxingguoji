import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { Client } from "pg";

import { loadLocalSyntheticConfig } from "../../lib/runtime/local-synthetic-config.ts";
import {
  LOCAL_SYNTHETIC_ORGANIZATION,
  LOCAL_SYNTHETIC_PRINCIPALS,
} from "../../modules/identity/server.ts";
import {
  ONE_ROLE_BASELINE_ID,
  ONE_ROLE_CANONICAL_ROLE,
  ONE_ROLE_MARKER_SCHEMA,
  ONE_ROLE_MARKER_TABLE,
  ONE_ROLE_SOURCE_COUNT,
  ONE_ROLE_TRANSFORM_VERSION,
  verifyCommittedOneRoleBaseline,
} from "./generate-one-role-baseline.ts";
import { readOneRoleBaselineTarget } from "./run-one-role-baseline.ts";

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

export interface LocalIdentitySeedTarget {
  readonly ownerConnectionString: string;
  readonly runtimeConnectionString: string;
}

export class LocalIdentitySeedSafetyError extends Error {
  constructor(message = "Local identity seed was rejected.") {
    super(message);
    this.name = "LocalIdentitySeedSafetyError";
  }
}

export function readLocalIdentitySeedTarget(
  environment: RuntimeEnvironment = process.env,
): LocalIdentitySeedTarget {
  try {
    const baseline = readOneRoleBaselineTarget(environment);
    const runtime = loadLocalSyntheticConfig(environment).database.connectionString;
    if (baseline.ssl !== false || new URL(runtime).toString() !== baseline.connectionString) {
      throw new LocalIdentitySeedSafetyError();
    }
    return Object.freeze({
      ownerConnectionString: baseline.connectionString,
      runtimeConnectionString: runtime,
    });
  } catch {
    throw new LocalIdentitySeedSafetyError();
  }
}

export async function seedLocalSyntheticIdentity(
  target: LocalIdentitySeedTarget,
): Promise<Readonly<{ users: number; memberships: number; roles: number }>> {
  const baseline = await verifyCommittedOneRoleBaseline();
  const client = new Client({
    connectionString: target.ownerConnectionString,
    application_name: "tianxing-local-identity-seed",
    connectionTimeoutMillis: 3_000,
    statement_timeout: 5_000,
    ssl: false,
  });
  await client.connect();
  try {
    await assertOneRoleSeedPreflight(client, sha256(baseline.manifestJson));
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    try {
      await client.query("SELECT set_config('app.organization_id', $1, true)", [
        LOCAL_SYNTHETIC_ORGANIZATION.id,
      ]);
      await seedPrincipals(client);
      const counts = await verifySeed(client);
      await client.query("COMMIT");
      return counts;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } finally {
    await client.end();
  }
}

async function assertOneRoleSeedPreflight(client: Client, manifestSha256: string): Promise<void> {
  const identity = await client.query<{
    database_name: string;
    user_name: string;
    database_owner: string;
    rolcanlogin: boolean;
    rolsuper: boolean;
    rolcreatedb: boolean;
    rolcreaterole: boolean;
    rolinherit: boolean;
    rolreplication: boolean;
    rolbypassrls: boolean;
  }>(`
    SELECT current_database() AS database_name,
           current_user AS user_name,
           pg_get_userbyid(database_row.datdba) AS database_owner,
           role_row.rolcanlogin, role_row.rolsuper, role_row.rolcreatedb,
           role_row.rolcreaterole, role_row.rolinherit, role_row.rolreplication,
           role_row.rolbypassrls
      FROM pg_database AS database_row
      JOIN pg_roles AS role_row ON role_row.rolname = current_user
     WHERE database_row.datname = current_database()
  `);
  const row = identity.rows[0];
  if (
    row?.database_name !== "tianxing" ||
    row.user_name !== ONE_ROLE_CANONICAL_ROLE ||
    row.database_owner !== ONE_ROLE_CANONICAL_ROLE ||
    !row.rolcanlogin || row.rolsuper || row.rolcreatedb || row.rolcreaterole ||
    row.rolinherit || row.rolreplication || row.rolbypassrls
  ) {
    throw new LocalIdentitySeedSafetyError();
  }
  const marker = await client.query<{
    baseline_id: string;
    transform_version: string;
    manifest_sha256: string;
    source_migration_count: number;
  }>(`
    SELECT baseline_id, transform_version, manifest_sha256, source_migration_count
      FROM ${ONE_ROLE_MARKER_SCHEMA}.${ONE_ROLE_MARKER_TABLE}
     WHERE baseline_id = $1
  `, [ONE_ROLE_BASELINE_ID]);
  const installed = marker.rows[0];
  if (
    installed?.transform_version !== ONE_ROLE_TRANSFORM_VERSION ||
    installed.manifest_sha256 !== manifestSha256 ||
    installed.source_migration_count !== ONE_ROLE_SOURCE_COUNT
  ) {
    throw new LocalIdentitySeedSafetyError();
  }
}

async function seedPrincipals(client: Client): Promise<void> {
  const founder = LOCAL_SYNTHETIC_PRINCIPALS[0]!;
  for (const principal of LOCAL_SYNTHETIC_PRINCIPALS) {
    await client.query(
      `INSERT INTO identity_users (id, normalized_email, status, created_by_user_id)
       VALUES ($1, $2, 'active', $3)
       ON CONFLICT (id) DO NOTHING`,
      [principal.userId, principal.normalizedEmail,
        principal.userId === founder.userId ? null : founder.userId],
    );
  }
  await client.query(
    `INSERT INTO access_organizations (id, display_name, status, created_by_user_id)
     VALUES ($1, $2, 'active', $3)
     ON CONFLICT (id) DO NOTHING`,
    [LOCAL_SYNTHETIC_ORGANIZATION.id, LOCAL_SYNTHETIC_ORGANIZATION.displayName, founder.userId],
  );
  for (const principal of LOCAL_SYNTHETIC_PRINCIPALS) {
    await client.query(
      `INSERT INTO access_organization_memberships
        (id, organization_id, user_id, status, created_by_user_id)
       VALUES ($1, $2, $3, 'active', $4)
       ON CONFLICT (id) DO NOTHING`,
      [principal.membershipId, LOCAL_SYNTHETIC_ORGANIZATION.id, principal.userId, founder.userId],
    );
    await client.query(
      `INSERT INTO access_role_bindings
        (id, organization_id, membership_id, user_id, role, status, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, 'active', $6)
       ON CONFLICT (id) DO NOTHING`,
      [principal.roleBindingId, LOCAL_SYNTHETIC_ORGANIZATION.id, principal.membershipId,
        principal.userId, principal.role, founder.userId],
    );
  }
}

async function verifySeed(
  client: Client,
): Promise<Readonly<{ users: number; memberships: number; roles: number }>> {
  const result = await client.query<{ users: number; memberships: number; roles: number }>(`
    SELECT
      (SELECT count(*)::int FROM identity_users WHERE id = ANY($1::uuid[])) AS users,
      (SELECT count(*)::int FROM access_organization_memberships
        WHERE id = ANY($2::uuid[]) AND organization_id = $4) AS memberships,
      (SELECT count(*)::int FROM access_role_bindings
        WHERE id = ANY($3::uuid[]) AND organization_id = $4 AND status = 'active') AS roles
  `, [
    LOCAL_SYNTHETIC_PRINCIPALS.map(({ userId }) => userId),
    LOCAL_SYNTHETIC_PRINCIPALS.map(({ membershipId }) => membershipId),
    LOCAL_SYNTHETIC_PRINCIPALS.map(({ roleBindingId }) => roleBindingId),
    LOCAL_SYNTHETIC_ORGANIZATION.id,
  ]);
  const counts = result.rows[0];
  if (
    counts?.users !== LOCAL_SYNTHETIC_PRINCIPALS.length ||
    counts.memberships !== LOCAL_SYNTHETIC_PRINCIPALS.length ||
    counts.roles !== LOCAL_SYNTHETIC_PRINCIPALS.length
  ) {
    throw new LocalIdentitySeedSafetyError();
  }
  return Object.freeze(counts);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function runCli(environment: RuntimeEnvironment): Promise<void> {
  const result = await seedLocalSyntheticIdentity(readLocalIdentitySeedTarget(environment));
  process.stdout.write(`${JSON.stringify({ ...result, status: "pass" })}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli(process.env).catch(() => {
    process.stderr.write("Local identity seed failed safely.\n");
    process.exitCode = 1;
  });
}
