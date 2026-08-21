import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { Pool, type PoolClient, type QueryResult } from "pg";

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
import {
  NEON_TEST_ORGANIZATION,
  NEON_TEST_PRINCIPALS,
} from "./neon-test-synthetic-fixture.ts";

type Environment = Readonly<Record<string, string | undefined>>;
type ProvisionStatus = "created" | "rotated" | "unchanged";

const POSTGRES_ERROR_SEVERITIES = new Set([
  "ERROR",
  "FATAL",
  "PANIC",
  "WARNING",
  "NOTICE",
  "DEBUG",
  "INFO",
  "LOG",
]);

export type DatabaseTestProvisionFailureStage =
  | "configuration"
  | "baseline_manifest"
  | "password_input"
  | "connection"
  | "transaction_begin"
  | "preflight_identity"
  | "preflight_marker"
  | "credential_lookup"
  | "password_derivation"
  | "provision_function"
  | "transaction_commit"
  | "transaction_rollback"
  | "connection_close";

export type DatabaseTestProvisionFailureEvidence = Readonly<{
  failure_stage: DatabaseTestProvisionFailureStage;
  postgres_code?: string;
}>;

export type DatabaseTestProvisionRollbackAttempt =
  | "not_attempted"
  | "succeeded"
  | "failed";
export type DatabaseTestProvisionRollbackState =
  | "not_started"
  | "not_applicable"
  | "clean"
  | "unknown";
export type DatabaseTestProvisionCommitResult =
  | "not_attempted"
  | "succeeded"
  | "uncertain";

export class DatabaseTestProvisionError extends Error {
  constructor() {
    super("Database test identity provisioning was rejected.");
    this.name = "DatabaseTestProvisionError";
  }
}

export class DatabaseTestProvisionOperationError extends DatabaseTestProvisionError {
  readonly originalFailure: DatabaseTestProvisionFailureEvidence;
  readonly transactionStarted: boolean;
  readonly commitResult: DatabaseTestProvisionCommitResult;
  readonly rollbackAttempt: DatabaseTestProvisionRollbackAttempt;
  readonly rollbackState: DatabaseTestProvisionRollbackState;
  readonly rollbackFailure?: DatabaseTestProvisionFailureEvidence;
  readonly connectionCloseFailure?: DatabaseTestProvisionFailureEvidence;

  constructor(input: Readonly<{
    originalFailure: DatabaseTestProvisionFailureEvidence;
    transactionStarted?: boolean;
    commitResult?: DatabaseTestProvisionCommitResult;
    rollbackAttempt?: DatabaseTestProvisionRollbackAttempt;
    rollbackState?: DatabaseTestProvisionRollbackState;
    rollbackFailure?: DatabaseTestProvisionFailureEvidence;
    connectionCloseFailure?: DatabaseTestProvisionFailureEvidence;
  }>) {
    super();
    this.name = "DatabaseTestProvisionOperationError";
    this.originalFailure = input.originalFailure;
    this.message = `Database test identity provisioning failed at ${input.originalFailure.failure_stage}.`;
    this.transactionStarted = input.transactionStarted === true;
    this.commitResult = input.commitResult ?? "not_attempted";
    this.rollbackAttempt = input.rollbackAttempt ?? "not_attempted";
    this.rollbackState = input.rollbackState ?? (
      this.transactionStarted ? "unknown" : "not_started"
    );
    this.rollbackFailure = input.rollbackFailure;
    this.connectionCloseFailure = input.connectionCloseFailure;
  }
}

export interface DatabaseTestProvisionTarget {
  readonly connectionString: string;
  readonly loginUser: string;
  readonly databaseName: string;
  readonly connectionTimeoutMs: number;
  readonly statementTimeoutMs: number;
  readonly ssl: false | Readonly<{ rejectUnauthorized: true }>;
}

export interface DatabaseTestProvisionQueryClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<Row>, "rows">>;
}

export type DatabaseTestProvisionConnection = Readonly<{
  client: DatabaseTestProvisionQueryClient;
  close(): Promise<void>;
}>;

export type DatabaseTestProvisionDependencies = Readonly<{
  verifyBaseline(): Promise<Readonly<{ manifestJson: string }>>;
  openConnection(target: DatabaseTestProvisionTarget): Promise<DatabaseTestProvisionConnection>;
  deriveVerifier(password: Uint8Array, salt: Uint8Array): Promise<Buffer>;
  createSalt(size: number): Buffer;
}>;

export type DatabaseTestProvisionArguments = Readonly<{
  normalizedEmail: string;
  rotate: boolean;
}>;

const DEFAULT_DEPENDENCIES: DatabaseTestProvisionDependencies = Object.freeze({
  verifyBaseline: verifyCommittedOneRoleBaseline,
  openConnection: openDatabaseTestProvisionConnection,
  deriveVerifier: deriveDatabaseTestVerifier,
  createSalt: randomBytes,
});

export function readDatabaseTestProvisionTarget(
  environment: Environment = process.env,
): DatabaseTestProvisionTarget {
  try {
    if (environment.VERCEL?.trim() || environment.VERCEL_ENV?.trim()) {
      throw new DatabaseTestProvisionError();
    }
    const target = readOneRoleBaselineTarget(environment);
    const appEnvironment = environment.APP_ENV?.trim();
    const validTestTarget = appEnvironment === "test" && target.ssl !== false;
    const validLocalTarget = appEnvironment === "development" && target.ssl === false;
    if (!validTestTarget && !validLocalTarget) {
      throw new DatabaseTestProvisionError();
    }
    return Object.freeze({
      connectionString: target.connectionString,
      loginUser: target.user,
      databaseName: target.database,
      connectionTimeoutMs: ONE_ROLE_BASELINE_TIMEOUTS.connectionMs,
      statementTimeoutMs: ONE_ROLE_BASELINE_TIMEOUTS.statementMs,
      ssl: target.ssl,
    });
  } catch {
    throw new DatabaseTestProvisionError();
  }
}

export function readDatabaseTestProvisionArguments(
  arguments_: readonly string[],
): DatabaseTestProvisionArguments {
  try {
    const { values } = parseArgs({
      args: [...arguments_],
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
    return Object.freeze({ normalizedEmail, rotate: values.rotate ?? false });
  } catch (error) {
    if (error instanceof DatabaseTestProvisionOperationError) throw error;
    throw operationError("configuration", error);
  }
}

export async function provisionDatabaseTestIdentity(input: Readonly<{
  target: DatabaseTestProvisionTarget;
  normalizedEmail: string;
  password: Uint8Array;
  rotate: boolean;
  dependencies?: DatabaseTestProvisionDependencies;
}>): Promise<ProvisionStatus> {
  const dependencies = input.dependencies ?? DEFAULT_DEPENDENCIES;
  const password = Buffer.from(input.password);
  let connection: DatabaseTestProvisionConnection | undefined;
  let transactionStarted = false;
  let commitResult: DatabaseTestProvisionCommitResult = "not_attempted";
  let operationFailure: DatabaseTestProvisionOperationError | undefined;
  let status: ProvisionStatus | undefined;

  try {
    if (
      normalizeSyntheticEmail(input.normalizedEmail) !== input.normalizedEmail ||
      password.byteLength < 1 ||
      password.byteLength > DATABASE_TEST_PASSWORD_POLICY.passwordMaxBytes
    ) {
      throw operationError("configuration");
    }

    let manifestSha256: string;
    try {
      const baseline = await dependencies.verifyBaseline();
      manifestSha256 = createHash("sha256").update(baseline.manifestJson).digest("hex");
    } catch (error) {
      throw operationError("baseline_manifest", error);
    }

    try {
      connection = await dependencies.openConnection(input.target);
    } catch (error) {
      throw operationError("connection", error);
    }

    try {
      await connection.client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      transactionStarted = true;
    } catch (error) {
      throw operationError("transaction_begin", error);
    }

    try {
      await assertOneRoleProvisionIdentityPreflight(connection.client, input.target);
      await connection.client.query(
        "SELECT set_config('app.organization_id', $1, true), set_config('app.actor_user_id', $2, true)",
        [NEON_TEST_ORGANIZATION.id, NEON_TEST_PRINCIPALS[0]!.userId],
      );
    } catch (error) {
      throw operationError("preflight_identity", error, { transactionStarted });
    }
    try {
      await assertOneRoleProvisionMarkerPreflight(connection.client, manifestSha256);
    } catch (error) {
      throw operationError("preflight_marker", error, { transactionStarted });
    }

    let existing: Pick<QueryResult<{
      user_id: string;
      verifier_version: string | null;
      password_salt: Buffer | null;
      password_verifier: Buffer | null;
      credential_status: string | null;
    }>, "rows">;
    try {
      existing = await connection.client.query(
        "SELECT * FROM identity_database_test_lookup_provision_credential($1)",
        [input.normalizedEmail],
      );
    } catch (error) {
      throw operationError("credential_lookup", error, { transactionStarted });
    }
    const row = existing.rows[0];
    if (!row) throw operationError("credential_lookup", undefined, { transactionStarted });
    if (row.password_salt && row.password_verifier) {
      if (
        row.verifier_version !== DATABASE_TEST_PASSWORD_POLICY.version ||
        row.password_salt.byteLength !== DATABASE_TEST_PASSWORD_POLICY.saltBytes ||
        row.password_verifier.byteLength !== DATABASE_TEST_PASSWORD_POLICY.keyLength
      ) {
        throw operationError("credential_lookup", undefined, { transactionStarted });
      }
      let currentVerifier: Buffer;
      try {
        currentVerifier = await dependencies.deriveVerifier(password, row.password_salt);
      } catch (error) {
        throw operationError("password_derivation", error, { transactionStarted });
      }
      const unchanged = timingSafeEqual(currentVerifier, row.password_verifier);
      currentVerifier.fill(0);
      if (unchanged && row.credential_status === "active") {
        status = "unchanged";
      } else if (!input.rotate) {
        throw operationError("credential_lookup", undefined, { transactionStarted });
      }
    }

    if (!status) {
      let salt: Buffer | undefined;
      let verifier: Buffer | undefined;
      try {
        salt = dependencies.createSalt(DATABASE_TEST_PASSWORD_POLICY.saltBytes);
        verifier = await dependencies.deriveVerifier(password, salt);
      } catch (error) {
        verifier?.fill(0);
        salt?.fill(0);
        throw operationError("password_derivation", error, { transactionStarted });
      }
      try {
        const provisioned = await connection.client.query<{ status: string }>(
          "SELECT identity_database_test_provision_credential($1, $2, $3, $4, $5) AS status",
          [input.normalizedEmail, DATABASE_TEST_PASSWORD_POLICY.version, salt, verifier, input.rotate],
        );
        const provisionedStatus = provisioned.rows[0]?.status;
        if (provisionedStatus !== "created" && provisionedStatus !== "rotated") {
          throw new DatabaseTestProvisionError();
        }
        status = provisionedStatus;
      } catch (error) {
        throw operationError("provision_function", error, { transactionStarted });
      } finally {
        verifier?.fill(0);
        salt?.fill(0);
      }
    }

    try {
      await connection.client.query("COMMIT");
      commitResult = "succeeded";
    } catch (error) {
      commitResult = "uncertain";
      throw operationError("transaction_commit", error, { transactionStarted, commitResult });
    }
  } catch (error) {
    operationFailure = normalizeOperationError(error, transactionStarted, commitResult);
    if (
      transactionStarted &&
      operationFailure.commitResult !== "succeeded" &&
      connection
    ) {
      try {
        await connection.client.query("ROLLBACK");
        operationFailure = copyOperationError(operationFailure, {
          rollbackAttempt: "succeeded",
          rollbackState: operationFailure.commitResult === "uncertain" ? "unknown" : "clean",
        });
      } catch (rollbackError) {
        operationFailure = copyOperationError(operationFailure, {
          rollbackAttempt: "failed",
          rollbackState: "unknown",
          rollbackFailure: failureEvidence("transaction_rollback", rollbackError),
        });
      }
    }
  } finally {
    password.fill(0);
  }

  let connectionCloseFailure: DatabaseTestProvisionFailureEvidence | undefined;
  if (connection) {
    try {
      await connection.close();
    } catch (error) {
      connectionCloseFailure = failureEvidence("connection_close", error);
    }
  }

  if (operationFailure) {
    throw copyOperationError(operationFailure, { connectionCloseFailure });
  }
  if (connectionCloseFailure) {
    throw new DatabaseTestProvisionOperationError({
      originalFailure: connectionCloseFailure,
      transactionStarted,
      commitResult,
      rollbackState: commitResult === "succeeded" ? "not_applicable" : "unknown",
    });
  }
  if (!status || commitResult !== "succeeded") {
    throw operationError("transaction_commit", undefined, {
      transactionStarted,
      commitResult: "uncertain",
    });
  }
  return status;
}

export async function runDatabaseTestProvisionCli(input: Readonly<{
  arguments: readonly string[];
  environment?: Environment;
  inputStream: AsyncIterable<Uint8Array>;
  inputStreamIsTty?: boolean;
  readTarget?: (environment: Environment) => DatabaseTestProvisionTarget;
  dependencies?: DatabaseTestProvisionDependencies;
}>): Promise<ProvisionStatus> {
  const arguments_ = readDatabaseTestProvisionArguments(input.arguments);
  let password: Buffer;
  try {
    password = await readDatabaseTestPasswordFromStream(
      input.inputStream,
      input.inputStreamIsTty ?? false,
    );
  } catch (error) {
    throw operationError("password_input", error);
  }
  try {
    let target: DatabaseTestProvisionTarget;
    try {
      target = (input.readTarget ?? readDatabaseTestProvisionTarget)(
        input.environment ?? process.env,
      );
    } catch (error) {
      throw operationError("configuration", error);
    }
    return await provisionDatabaseTestIdentity({
      target,
      normalizedEmail: arguments_.normalizedEmail,
      password,
      rotate: arguments_.rotate,
      dependencies: input.dependencies,
    });
  } finally {
    password.fill(0);
  }
}

export function formatDatabaseTestProvisionFailure(error: unknown): string {
  const operation = error instanceof DatabaseTestProvisionOperationError
    ? error
    : operationError("configuration", error);
  const retryForbidden = operation.commitResult === "succeeded" ||
    operation.commitResult === "uncertain" ||
    operation.rollbackState === "unknown";
  return JSON.stringify({
    status: "failed",
    operation: "database_test_identity_provision",
    original_failure: operation.originalFailure,
    transaction_started: operation.transactionStarted,
    commit_result: operation.commitResult,
    rollback_attempt: operation.rollbackAttempt,
    rollback_state: operation.rollbackState,
    ...(operation.rollbackFailure ? { rollback_failure: operation.rollbackFailure } : {}),
    ...(operation.connectionCloseFailure
      ? { connection_close_failure: operation.connectionCloseFailure }
      : {}),
    ...(retryForbidden
      ? { retry: "forbidden", operator_action: "freeze_and_escalate" }
      : {}),
  });
}

async function main(): Promise<void> {
  const status = await runDatabaseTestProvisionCli({
    arguments: process.argv.slice(2),
    environment: process.env,
    inputStream: process.stdin,
    inputStreamIsTty: process.stdin.isTTY,
  });
  process.stdout.write(`${JSON.stringify({ status })}\n`);
}

async function assertOneRoleProvisionIdentityPreflight(
  client: DatabaseTestProvisionQueryClient,
  target: DatabaseTestProvisionTarget,
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
}

async function assertOneRoleProvisionMarkerPreflight(
  client: DatabaseTestProvisionQueryClient,
  manifestSha256: string,
): Promise<void> {
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

async function openDatabaseTestProvisionConnection(
  target: DatabaseTestProvisionTarget,
): Promise<DatabaseTestProvisionConnection> {
  const pool = new Pool({
    connectionString: target.connectionString,
    application_name: "tianxing-test-identity-provision",
    max: 1,
    connectionTimeoutMillis: target.connectionTimeoutMs,
    statement_timeout: target.statementTimeoutMs,
    ssl: target.ssl,
  });
  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch (error) {
    await pool.end().catch(() => {});
    throw error;
  }
  return Object.freeze({
    client,
    close: async () => {
      try {
        client.release();
      } finally {
        await pool.end();
      }
    },
  });
}

function operationError(
  stage: DatabaseTestProvisionFailureStage,
  error?: unknown,
  state: Readonly<{
    transactionStarted?: boolean;
    commitResult?: DatabaseTestProvisionCommitResult;
  }> = {},
): DatabaseTestProvisionOperationError {
  return new DatabaseTestProvisionOperationError({
    originalFailure: failureEvidence(stage, error),
    transactionStarted: state.transactionStarted,
    commitResult: state.commitResult,
  });
}

function normalizeOperationError(
  error: unknown,
  transactionStarted: boolean,
  commitResult: DatabaseTestProvisionCommitResult,
): DatabaseTestProvisionOperationError {
  if (error instanceof DatabaseTestProvisionOperationError) return error;
  return operationError("provision_function", error, { transactionStarted, commitResult });
}

function copyOperationError(
  error: DatabaseTestProvisionOperationError,
  changes: Readonly<{
    rollbackAttempt?: DatabaseTestProvisionRollbackAttempt;
    rollbackState?: DatabaseTestProvisionRollbackState;
    rollbackFailure?: DatabaseTestProvisionFailureEvidence;
    connectionCloseFailure?: DatabaseTestProvisionFailureEvidence;
  }>,
): DatabaseTestProvisionOperationError {
  return new DatabaseTestProvisionOperationError({
    originalFailure: error.originalFailure,
    transactionStarted: error.transactionStarted,
    commitResult: error.commitResult,
    rollbackAttempt: changes.rollbackAttempt ?? error.rollbackAttempt,
    rollbackState: changes.rollbackState ?? error.rollbackState,
    rollbackFailure: changes.rollbackFailure ?? error.rollbackFailure,
    connectionCloseFailure: changes.connectionCloseFailure ?? error.connectionCloseFailure,
  });
}

function failureEvidence(
  stage: DatabaseTestProvisionFailureStage,
  error?: unknown,
): DatabaseTestProvisionFailureEvidence {
  const postgresCode = readPostgresCode(error);
  return Object.freeze({
    failure_stage: stage,
    ...(postgresCode ? { postgres_code: postgresCode } : {}),
  });
}

function readPostgresCode(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    const databaseError = current as Error & { code?: unknown; severity?: unknown };
    const code = databaseError.code;
    if (
      POSTGRES_ERROR_SEVERITIES.has(String(databaseError.severity)) &&
      typeof code === "string" &&
      /^[0-9A-Z]{5}$/.test(code)
    ) {
      return code;
    }
    current = current.cause;
  }
  return undefined;
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
  main().catch((error: unknown) => {
    process.stderr.write(`${formatDatabaseTestProvisionFailure(error)}\n`);
    process.exitCode = 1;
  });
}
