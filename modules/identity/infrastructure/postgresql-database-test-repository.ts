import "server-only";

import { Pool } from "pg";

import type { OrganizationRole } from "../../access/public.ts";
import {
  DATABASE_TEST_PASSWORD_POLICY,
  type DatabaseTestCredentialSnapshot,
  type DatabaseTestLoginRepository,
} from "../application/database-test-login.ts";
import { IdentityRepositoryError } from "../application/session-port.ts";
import type { IdentitySessionActor } from "../domain/actor.ts";
import { TEST_IDENTITY_GROUP_ROLE } from "../../../lib/runtime/test-database-config.ts";

interface DatabaseTestIdentityPool {
  connect(): Promise<DatabaseTestIdentityClient>;
}

interface DatabaseTestIdentityClient {
  query<Row = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[] }>;
  release(): void;
}

interface CredentialRow {
  user_id: string;
  verifier_version: string;
  password_salt: Buffer;
  password_verifier: Buffer;
  credential_version: string | number;
}

interface ActorRow {
  allowed: boolean;
  user_id: string | null;
  normalized_email: string | null;
  organization_id: string | null;
  membership_id: string | null;
  role_binding_id: string | null;
  role: OrganizationRole | null;
  session_id: string | null;
  captured_session_version: string | number | null;
  reauthenticated_at: Date | string | null;
}

export interface DatabaseTestSessionActor extends IdentitySessionActor {
  readonly normalizedEmail: string;
  readonly membershipId: string;
  readonly roleBindingId: string;
}

export class DatabaseTestRepositoryUnavailable extends Error {
  constructor(options?: ErrorOptions) {
    super("Database test identity repository is unavailable.", options);
    this.name = "DatabaseTestRepositoryUnavailable";
  }
}

export class DatabaseTestIdentityRoleError extends Error {
  constructor() {
    super("Database test identity login role is not authorized.");
    this.name = "DatabaseTestIdentityRoleError";
  }
}

export class PostgresqlDatabaseTestSessionRepository implements DatabaseTestLoginRepository {
  private readonly pool: DatabaseTestIdentityPool;
  private readonly expectedLoginUser: string;

  constructor(pool: DatabaseTestIdentityPool, expectedLoginUser: string) {
    this.pool = pool;
    this.expectedLoginUser = expectedLoginUser;
  }

  async findCredential(normalizedEmail: string): Promise<DatabaseTestCredentialSnapshot | null> {
    return this.transaction(async (client) => {
      const result = await client.query<CredentialRow>(
        "SELECT * FROM identity_database_test_lookup_credential($1)",
        [normalizedEmail],
      );
      const row = result.rows[0];
      if (!row) return null;
      if (
        row.verifier_version !== DATABASE_TEST_PASSWORD_POLICY.version ||
        row.password_salt.byteLength !== DATABASE_TEST_PASSWORD_POLICY.saltBytes ||
        row.password_verifier.byteLength !== DATABASE_TEST_PASSWORD_POLICY.keyLength
      ) {
        return null;
      }
      return Object.freeze({
        userId: row.user_id,
        verifierVersion: DATABASE_TEST_PASSWORD_POLICY.version,
        salt: Uint8Array.from(row.password_salt),
        verifier: Uint8Array.from(row.password_verifier),
        credentialVersion: positiveInteger(row.credential_version),
      });
    });
  }

  async completeLoginAttempt(input: Readonly<{
    userId: string | null;
    expectedCredentialVersion: number | null;
    passwordMatched: boolean;
    sessionId: string;
    secretHash: string;
    nowMs: number;
  }>): Promise<IdentitySessionActor | null> {
    return this.transaction(async (client) => {
      const result = await client.query<ActorRow>(
        `SELECT * FROM identity_database_test_complete_login(
           $1, $2, $3, $4, $5, $6
         )`,
        [
          input.userId,
          input.expectedCredentialVersion,
          input.passwordMatched,
          input.sessionId,
          hashBuffer(input.secretHash),
          new Date(input.nowMs),
        ],
      );
      return actorFromRow(result.rows[0]);
    });
  }

  async findActorBySessionSecretHash(input: Readonly<{
    secretHash: string;
    nowMs: number;
    sensitiveAction: boolean;
  }>): Promise<DatabaseTestSessionActor> {
    const actor = await this.transaction(async (client) => {
      const result = await client.query<ActorRow>(
        "SELECT * FROM identity_database_test_resolve_session($1, $2, $3)",
        [hashBuffer(input.secretHash), new Date(input.nowMs), input.sensitiveAction],
      );
      return actorFromRow(result.rows[0]);
    });
    if (!actor) throw new IdentityRepositoryError("SESSION_NOT_FOUND");
    return actor;
  }

  findLegacyActorBySessionSecretHash(input: Readonly<{
    secretHash: string;
    nowMs: number;
    sensitiveAction: boolean;
  }>): Promise<DatabaseTestSessionActor> {
    return this.findActorBySessionSecretHash(input);
  }

  async revokeSessionBySecretHash(input: Readonly<{
    secretHash: string;
    reason: string;
  }>): Promise<void> {
    await this.transaction(async (client) => {
      await client.query(
        "SELECT identity_database_test_revoke_session($1, $2)",
        [hashBuffer(input.secretHash), safeReason(input.reason)],
      );
    });
  }

  private async transaction<Result>(
    operation: (client: DatabaseTestIdentityClient) => Promise<Result>,
  ): Promise<Result> {
    let client: DatabaseTestIdentityClient | undefined;
    try {
      client = await this.pool.connect();
      await client.query("BEGIN");
      const preflight = await client.query<{ current_user: string; has_required_role: boolean }>(
        "SELECT current_user, pg_has_role(current_user, $1, 'member') AS has_required_role",
        [TEST_IDENTITY_GROUP_ROLE],
      );
      const role = preflight.rows[0];
      if (role?.current_user !== this.expectedLoginUser || role.has_required_role !== true) {
        throw new DatabaseTestIdentityRoleError();
      }
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      if (client) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // The owning error remains the only error crossing the repository boundary.
        }
      }
      if (error instanceof IdentityRepositoryError || error instanceof DatabaseTestIdentityRoleError) {
        throw error;
      }
      throw new DatabaseTestRepositoryUnavailable({ cause: error });
    } finally {
      client?.release();
    }
  }
}

const globalForDatabaseTestIdentity = globalThis as typeof globalThis & {
  __txDatabaseTestIdentityPools?: Map<string, Pool>;
};

export function getPostgresqlDatabaseTestSessionRepository(config: Readonly<{
  connectionString: string;
  loginUser: string;
  connectionTimeoutMs: number;
  statementTimeoutMs: number;
  poolMax: 1;
  ssl: Readonly<{ rejectUnauthorized: true }>;
}>): PostgresqlDatabaseTestSessionRepository {
  const pools = globalForDatabaseTestIdentity.__txDatabaseTestIdentityPools ?? new Map<string, Pool>();
  globalForDatabaseTestIdentity.__txDatabaseTestIdentityPools = pools;
  let pool = pools.get(config.connectionString);
  if (!pool) {
    pool = new Pool({
      connectionString: config.connectionString,
      application_name: "tianxing-test-identity",
      max: config.poolMax,
      connectionTimeoutMillis: config.connectionTimeoutMs,
      statement_timeout: config.statementTimeoutMs,
      ssl: config.ssl,
    });
    pools.set(config.connectionString, pool);
  }
  return new PostgresqlDatabaseTestSessionRepository(pool, config.loginUser);
}

function actorFromRow(row: ActorRow | undefined): DatabaseTestSessionActor | null {
  if (!row?.allowed) return null;
  if (
    !row.user_id ||
    !row.normalized_email ||
    !row.organization_id ||
    !row.membership_id ||
    !row.role_binding_id ||
    !row.role ||
    !row.session_id
  ) {
    throw new DatabaseTestRepositoryUnavailable();
  }
  return Object.freeze({
    userId: row.user_id,
    normalizedEmail: row.normalized_email,
    organizationId: row.organization_id,
    membershipId: row.membership_id,
    roleBindingId: row.role_binding_id,
    role: row.role,
    sessionId: row.session_id,
    capturedSessionVersion: positiveInteger(row.captured_session_version),
    reauthenticatedAtMs: row.reauthenticated_at === null
      ? null
      : timestampMillis(row.reauthenticated_at),
  });
}

function timestampMillis(value: Date | string): number {
  const milliseconds = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(milliseconds)) throw new DatabaseTestRepositoryUnavailable();
  return milliseconds;
}

function positiveInteger(value: string | number | null): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new DatabaseTestRepositoryUnavailable();
  return parsed;
}

function hashBuffer(hash: string): Buffer {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new TypeError("Database test session hash is invalid.");
  return Buffer.from(hash, "hex");
}

function safeReason(reason: string): string {
  const value = reason.trim();
  return value && value.length <= 128 && !/[\r\n]/.test(value)
    ? value
    : "database_test_session_revoked";
}

export type { DatabaseTestIdentityClient, DatabaseTestIdentityPool };
