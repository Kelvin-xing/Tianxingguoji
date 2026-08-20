import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { Pool, type PoolClient } from "pg";

import {
  DATABASE_TEST_PASSWORD_POLICY,
  deriveDatabaseTestVerifier,
  normalizeSyntheticEmail,
} from "../../modules/identity/application/database-test-login.ts";
import {
  ONE_ROLE_BASELINE_ID,
  ONE_ROLE_CANONICAL_ROLE,
  ONE_ROLE_MARKER_SCHEMA,
  ONE_ROLE_MARKER_TABLE,
  ONE_ROLE_SOURCE_COUNT,
  ONE_ROLE_TRANSFORM_VERSION,
  verifyCommittedOneRoleBaseline,
} from "./generate-one-role-baseline.ts";
import {
  ONE_ROLE_BASELINE_TIMEOUTS,
  readOneRoleBaselineTarget,
} from "./run-one-role-baseline.ts";

type Environment = Readonly<Record<string, string | undefined>>;

export class DatabaseTestProvisionError extends Error {
  constructor() {
    super("Database test identity provisioning was rejected.");
    this.name = "DatabaseTestProvisionError";
  }
}

export interface DatabaseTestProvisionTarget {
  readonly connectionString: string;
  readonly loginUser: string;
  readonly databaseName: string;
  readonly connectionTimeoutMs: number;
  readonly statementTimeoutMs: number;
}

export function readDatabaseTestProvisionTarget(
  environment: Environment = process.env,
): DatabaseTestProvisionTarget {
  try {
    if (environment.VERCEL?.trim() || environment.VERCEL_ENV?.trim()) {
      throw new DatabaseTestProvisionError();
    }
    const target = readOneRoleBaselineTarget(environment);
    if (environment.APP_ENV?.trim() !== "test" || target.ssl === false) {
      throw new DatabaseTestProvisionError();
    }
    return Object.freeze({
      connectionString: target.connectionString,
      loginUser: target.user,
      databaseName: target.database,
      connectionTimeoutMs: ONE_ROLE_BASELINE_TIMEOUTS.connectionMs,
      statementTimeoutMs: ONE_ROLE_BASELINE_TIMEOUTS.statementMs,
    });
  } catch {
    throw new DatabaseTestProvisionError();
  }
}

export async function provisionDatabaseTestIdentity(input: Readonly<{
  target: DatabaseTestProvisionTarget;
  normalizedEmail: string;
  password: Uint8Array;
  rotate: boolean;
}>): Promise<"created" | "rotated" | "unchanged"> {
  if (normalizeSyntheticEmail(input.normalizedEmail) !== input.normalizedEmail) {
    throw new DatabaseTestProvisionError();
  }
  const password = Buffer.from(input.password);
  if (
    password.byteLength < 1 ||
    password.byteLength > DATABASE_TEST_PASSWORD_POLICY.passwordMaxBytes
  ) {
    password.fill(0);
    throw new DatabaseTestProvisionError();
  }
  const baseline = await verifyCommittedOneRoleBaseline();
  const pool = new Pool({
    connectionString: input.target.connectionString,
    application_name: "tianxing-test-identity-provision",
    max: 1,
    connectionTimeoutMillis: input.target.connectionTimeoutMs,
    statement_timeout: input.target.statementTimeoutMs,
    ssl: { rejectUnauthorized: true },
  });
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await assertOneRoleProvisionPreflight(
      client,
      input.target,
      createHash("sha256").update(baseline.manifestJson).digest("hex"),
    );
    const existing = await client.query<{
      user_id: string;
      verifier_version: string | null;
      password_salt: Buffer | null;
      password_verifier: Buffer | null;
      credential_status: string | null;
    }>("SELECT * FROM identity_database_test_lookup_provision_credential($1)", [input.normalizedEmail]);
    const row = existing.rows[0];
    if (!row) throw new DatabaseTestProvisionError();
    if (row.password_salt && row.password_verifier) {
      if (
        row.verifier_version !== DATABASE_TEST_PASSWORD_POLICY.version ||
        row.password_salt.byteLength !== DATABASE_TEST_PASSWORD_POLICY.saltBytes ||
        row.password_verifier.byteLength !== DATABASE_TEST_PASSWORD_POLICY.keyLength
      ) {
        throw new DatabaseTestProvisionError();
      }
      const currentVerifier = await deriveDatabaseTestVerifier(password, row.password_salt);
      const unchanged = timingSafeEqual(currentVerifier, row.password_verifier);
      currentVerifier.fill(0);
      if (unchanged && row.credential_status === "active") {
        await client.query("COMMIT");
        return "unchanged";
      }
      if (!input.rotate) throw new DatabaseTestProvisionError();
    }

    const salt = randomBytes(DATABASE_TEST_PASSWORD_POLICY.saltBytes);
    const verifier = await deriveDatabaseTestVerifier(password, salt);
    let provisioned;
    try {
      provisioned = await client.query<{ status: string }>(
        "SELECT identity_database_test_provision_credential($1, $2, $3, $4, $5) AS status",
        [input.normalizedEmail, DATABASE_TEST_PASSWORD_POLICY.version, salt, verifier, input.rotate],
      );
    } finally {
      verifier.fill(0);
      salt.fill(0);
    }
    const status = provisioned.rows[0]?.status;
    if (status !== "created" && status !== "rotated") throw new DatabaseTestProvisionError();
    await client.query("COMMIT");
    return status;
  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve only the fixed provisioning failure.
      }
    }
    throw error instanceof DatabaseTestProvisionError ? error : new DatabaseTestProvisionError();
  } finally {
    password.fill(0);
    client?.release();
    await pool.end();
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      email: { type: "string" },
      rotate: { type: "boolean", default: false },
      "password-stdin": { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (!values["password-stdin"] || !values.email) throw new DatabaseTestProvisionError();
  const normalizedEmail = normalizeSyntheticEmail(values.email);
  if (!normalizedEmail) throw new DatabaseTestProvisionError();
  const password = await readDatabaseTestPasswordFromStream(process.stdin, process.stdin.isTTY);
  try {
    const status = await provisionDatabaseTestIdentity({
      target: readDatabaseTestProvisionTarget(),
      normalizedEmail,
      password,
      rotate: values.rotate ?? false,
    });
    process.stdout.write(`${JSON.stringify({ status })}\n`);
  } finally {
    password.fill(0);
  }
}

async function assertOneRoleProvisionPreflight(
  client: PoolClient,
  target: DatabaseTestProvisionTarget,
  manifestSha256: string,
): Promise<void> {
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
    SELECT current_database() AS database_name, current_user AS user_name,
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
    row?.database_name !== target.databaseName || row.user_name !== ONE_ROLE_CANONICAL_ROLE ||
    row.database_owner !== ONE_ROLE_CANONICAL_ROLE || !row.rolcanlogin || row.rolsuper ||
    row.rolcreatedb || row.rolcreaterole || row.rolinherit || row.rolreplication ||
    row.rolbypassrls
  ) {
    throw new DatabaseTestProvisionError();
  }
  const marker = await client.query<{
    transform_version: string;
    manifest_sha256: string;
    source_migration_count: number;
  }>(`
    SELECT transform_version, manifest_sha256, source_migration_count
      FROM ${ONE_ROLE_MARKER_SCHEMA}.${ONE_ROLE_MARKER_TABLE}
     WHERE baseline_id = $1
  `, [ONE_ROLE_BASELINE_ID]);
  const installed = marker.rows[0];
  if (
    installed?.transform_version !== ONE_ROLE_TRANSFORM_VERSION ||
    installed.manifest_sha256 !== manifestSha256 ||
    installed.source_migration_count !== ONE_ROLE_SOURCE_COUNT
  ) {
    throw new DatabaseTestProvisionError();
  }
}

export async function readDatabaseTestPasswordFromStream(
  input: AsyncIterable<Uint8Array>,
  isTty = false,
): Promise<Buffer> {
  if (isTty) throw new DatabaseTestProvisionError();
  const chunks: Buffer[] = [];
  let combined: Buffer | undefined;
  let length = 0;
  try {
    for await (const chunk of input) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(bytes);
      length += bytes.byteLength;
      if (length > DATABASE_TEST_PASSWORD_POLICY.passwordMaxBytes + 1) {
        throw new DatabaseTestProvisionError();
      }
    }
    combined = Buffer.concat(chunks);
    let end = combined.byteLength;
    if (end > 0 && combined[end - 1] === 0x0a) end -= 1;
    if (end > 0 && combined[end - 1] === 0x0d) end -= 1;
    const password = Buffer.from(combined.subarray(0, end));
    if (
      password.byteLength < 1 ||
      password.byteLength > DATABASE_TEST_PASSWORD_POLICY.passwordMaxBytes
    ) {
      password.fill(0);
      throw new DatabaseTestProvisionError();
    }
    return password;
  } catch (error) {
    throw error instanceof DatabaseTestProvisionError ? error : new DatabaseTestProvisionError();
  } finally {
    combined?.fill(0);
    chunks.forEach((chunk) => chunk.fill(0));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write("Database test identity provisioning failed safely.\n");
    process.exitCode = 1;
  });
}
