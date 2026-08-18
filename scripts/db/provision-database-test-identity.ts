import { randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { Pool, type PoolClient } from "pg";

import { TEST_DATABASE_TIMEOUT_LIMITS } from "../../lib/runtime/test-database-config.ts";
import {
  DATABASE_TEST_PASSWORD_POLICY,
  deriveDatabaseTestVerifier,
  normalizeSyntheticEmail,
} from "../../modules/identity/application/database-test-login.ts";

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
  readonly connectionTimeoutMs: number;
  readonly statementTimeoutMs: number;
}

export function readDatabaseTestProvisionTarget(
  environment: Environment = process.env,
): DatabaseTestProvisionTarget {
  if (
    environment.APP_ENV?.trim() !== "test" ||
    environment.NODE_ENV?.trim() !== "production" ||
    environment.APP_RUNTIME_MODE?.trim() !== "test-database" ||
    environment.AUTH_MODE?.trim() !== "database-test"
  ) {
    throw new DatabaseTestProvisionError();
  }
  const expectedName = required(environment, "TEST_DATABASE_EXPECTED_NAME");
  if (
    !/^[a-z][a-z0-9_]{0,62}$/.test(expectedName) ||
    new Set(["postgres", "template0", "template1", "tianxing"]).has(expectedName)
  ) {
    throw new DatabaseTestProvisionError();
  }
  let url: URL;
  try {
    url = new URL(required(environment, "TEST_PROVISION_DATABASE_URL"));
  } catch {
    throw new DatabaseTestProvisionError();
  }
  const host = url.hostname.toLowerCase();
  let databaseName: string;
  let loginUser: string;
  try {
    databaseName = decodeURIComponent(url.pathname.slice(1));
    loginUser = decodeURIComponent(url.username);
  } catch {
    throw new DatabaseTestProvisionError();
  }
  if (
    url.protocol !== "postgresql:" ||
    url.password.length === 0 ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    url.pathname.split("/").length !== 2 ||
    databaseName !== expectedName ||
    isLoopbackOrIp(host) ||
    loginUser.length === 0 ||
    new Set([
      "postgres",
      "tianxing_app",
      "tianxing_test_application",
      "tianxing_test_identity",
      "tianxing_test_provisioner",
      "tianxing_migration",
      "tianxing_test_migration",
    ]).has(loginUser)
  ) {
    throw new DatabaseTestProvisionError();
  }
  return Object.freeze({
    connectionString: url.toString(),
    loginUser,
    connectionTimeoutMs: boundedInteger(
      environment,
      "TEST_DATABASE_CONNECTION_TIMEOUT_MS",
      TEST_DATABASE_TIMEOUT_LIMITS.connection,
    ),
    statementTimeoutMs: boundedInteger(
      environment,
      "TEST_DATABASE_STATEMENT_TIMEOUT_MS",
      TEST_DATABASE_TIMEOUT_LIMITS.statement,
    ),
  });
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
    await client.query("BEGIN");
    const preflight = await client.query<{ current_user: string; has_required_role: boolean }>(
      "SELECT current_user, pg_has_role(current_user, $1, 'member') AS has_required_role",
      ["tianxing_test_provisioner"],
    );
    if (
      preflight.rows[0]?.current_user !== input.target.loginUser ||
      preflight.rows[0]?.has_required_role !== true
    ) {
      throw new DatabaseTestProvisionError();
    }

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
        `SELECT identity_database_test_provision_credential($1, $2, $3, $4, $5) AS status`,
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
        // Never replace the owning safe provisioning failure with rollback detail.
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

function isLoopbackOrIp(host: string): boolean {
  const address = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return host === "localhost" || host.endsWith(".localhost") || host === "ip6-localhost" ||
    isIP(address) !== 0;
}

function boundedInteger(
  environment: Environment,
  variable: string,
  limits: Readonly<{ minimumMs: number; maximumMs: number }>,
): number {
  const value = required(environment, variable);
  if (!/^\d+$/.test(value)) throw new DatabaseTestProvisionError();
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < limits.minimumMs ||
    parsed > limits.maximumMs
  ) {
    throw new DatabaseTestProvisionError();
  }
  return parsed;
}

function required(environment: Environment, variable: string): string {
  const value = environment[variable]?.trim();
  if (!value || /[\r\n]/.test(value)) throw new DatabaseTestProvisionError();
  return value;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write("Database test identity provisioning failed safely.\n");
    process.exitCode = 1;
  });
}
