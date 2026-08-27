import "server-only";

import { Pool } from "pg";

import type { OrganizationRole } from "../../access/public.ts";
import type { IdentitySessionActor } from "../domain/actor.ts";
import { evaluateSession, SESSION_POLICY } from "../domain/contract.ts";
import {
  IdentityRepositoryError,
  type LocalSyntheticSessionRepository,
} from "../application/session-port.ts";
import type { SessionActor } from "./postgresql-session-service.ts";
import {
  getLocalSyntheticPrincipal,
  LOCAL_SYNTHETIC_ORGANIZATION,
} from "./local-synthetic-principals.ts";

interface LocalIdentityPool {
  connect(): Promise<LocalIdentityClient>;
}

interface LocalIdentityClient {
  query<Row = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: Row[] }>;
  release(): void;
}

interface LocalIdentitySessionRow {
  session_id: string;
  user_id: string;
  normalized_email: string;
  user_status: "invited" | "active" | "disabled";
  current_session_version: string | number;
  captured_session_version: string | number;
  session_status: "active" | "revoked" | "expired";
  session_kind: "local_synthetic";
  organization_id: string;
  organization_status: "active" | "disabled";
  membership_id: string;
  membership_status: "invited" | "active" | "disabled";
  role_binding_id: string;
  role: OrganizationRole;
  last_seen_at: Date | string;
  idle_expires_at: Date | string;
  absolute_expires_at: Date | string;
  reauthenticated_at: Date | string | null;
}

interface LocalPrincipalRow {
  user_id: string;
  normalized_email: string;
  session_version: string | number;
  organization_id: string;
  membership_id: string;
  role_binding_id: string;
  role: OrganizationRole;
}

export class LocalSyntheticIdentityInvariantError extends Error {
  constructor() {
    super("Local synthetic identity seed is missing or inconsistent.");
    this.name = "LocalSyntheticIdentityInvariantError";
  }
}

export class PostgresqlLocalSyntheticSessionRepository
implements LocalSyntheticSessionRepository {
  private readonly pool: LocalIdentityPool;

  constructor(pool: LocalIdentityPool) {
    this.pool = pool;
  }

  async createLocalSyntheticSession(input: {
    readonly userId: string;
    readonly organizationId: string;
    readonly role: OrganizationRole;
    readonly sessionId: string;
    readonly secretHash: string;
    readonly nowMs: number;
  }): Promise<IdentitySessionActor> {
    const principal = getLocalSyntheticPrincipal(input.role);
    if (
      input.organizationId !== LOCAL_SYNTHETIC_ORGANIZATION.id ||
      input.userId !== principal.userId
    ) {
      throw new LocalSyntheticIdentityInvariantError();
    }

    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        principal.userId,
      ]);
      const result = await client.query<LocalPrincipalRow>(
        `SELECT
           identity_user.id AS user_id,
           identity_user.normalized_email,
           identity_user.session_version,
           organization.id AS organization_id,
           membership.id AS membership_id,
           role_binding.id AS role_binding_id,
           role_binding.role
         FROM identity_users AS identity_user
         JOIN access_organization_memberships AS membership
           ON membership.user_id = identity_user.id
          AND membership.status = 'active'
         JOIN access_organizations AS organization
           ON organization.id = membership.organization_id
          AND organization.status = 'active'
         JOIN access_role_bindings AS role_binding
           ON role_binding.membership_id = membership.id
          AND role_binding.organization_id = membership.organization_id
          AND role_binding.user_id = membership.user_id
          AND role_binding.status = 'active'
        WHERE identity_user.id = $1
          AND identity_user.status = 'active'
          AND identity_user.normalized_email = $2
          AND organization.id = $3
          AND membership.id = $4
          AND role_binding.id = $5
          AND role_binding.role = $6`,
        [
          principal.userId,
          principal.normalizedEmail,
          LOCAL_SYNTHETIC_ORGANIZATION.id,
          principal.membershipId,
          principal.roleBindingId,
          principal.role,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new LocalSyntheticIdentityInvariantError();

      const now = new Date(input.nowMs);
      await client.query(
        `UPDATE identity_sessions
            SET status = 'revoked',
                revoked_at = $2,
                revoke_reason = 'local_role_relogin',
                record_version = record_version + 1,
                updated_at = $2
          WHERE user_id = $1
            AND session_kind = 'local_synthetic'
            AND status = 'active'`,
        [principal.userId, now],
      );

      const absoluteExpiresAtMs = input.nowMs + SESSION_POLICY.absoluteTimeoutMs;
      const idleExpiresAtMs = Math.min(
        input.nowMs + SESSION_POLICY.idleTimeoutMs,
        absoluteExpiresAtMs,
      );
      const capturedSessionVersion = toSafeInteger(row.session_version);
      await client.query(
        `INSERT INTO identity_sessions (
           id,
           user_id,
           organization_id,
           membership_id,
           secret_hash,
           captured_session_version,
           session_slot,
           status,
           session_kind,
           provider_token_ciphertext,
           provider_token_key_version,
           last_seen_at,
           idle_expires_at,
           absolute_expires_at,
           reauthenticated_at,
           created_at,
           updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, 1, 'active', 'local_synthetic',
           NULL, NULL, $7, $8, $9, $7, $7, $7
         )`,
        [
          input.sessionId,
          principal.userId,
          LOCAL_SYNTHETIC_ORGANIZATION.id,
          principal.membershipId,
          secretHashBuffer(input.secretHash),
          capturedSessionVersion,
          now,
          new Date(idleExpiresAtMs),
          new Date(absoluteExpiresAtMs),
        ],
      );

      return Object.freeze({
        userId: principal.userId,
        organizationId: LOCAL_SYNTHETIC_ORGANIZATION.id,
        role: principal.role,
        sessionId: input.sessionId,
        capturedSessionVersion,
        reauthenticatedAtMs: input.nowMs,
      });
    });
  }

  async findActorBySessionSecretHash(input: {
    readonly secretHash: string;
    readonly nowMs: number;
    readonly sensitiveAction: boolean;
  }): Promise<import("../domain/actor.ts").CanonicalIdentitySessionActor> {
    const actor = await this.findSessionActor(input);
    return Object.freeze({
      userId: actor.userId,
      organizationId: actor.organizationId,
      membershipId: actor.membershipId,
      role: actor.role,
      sessionId: actor.sessionId,
      capturedSessionVersion: actor.capturedSessionVersion,
      reauthenticatedAtMs: actor.reauthenticatedAt,
    });
  }

  findLegacyActorBySessionSecretHash(input: {
    readonly secretHash: string;
    readonly nowMs: number;
    readonly sensitiveAction: boolean;
  }): Promise<SessionActor> {
    return this.findSessionActor(input);
  }

  async revokeSessionBySecretHash(input: {
    readonly secretHash: string;
    readonly reason: string;
  }): Promise<void> {
    await this.transaction(async (client) => {
      await client.query(
        `UPDATE identity_sessions
            SET status = 'revoked',
                revoked_at = transaction_timestamp(),
                revoke_reason = $2,
                record_version = record_version + 1,
                updated_at = transaction_timestamp()
          WHERE secret_hash = $1
            AND session_kind = 'local_synthetic'
            AND status = 'active'`,
        [secretHashBuffer(input.secretHash), sanitizedReason(input.reason)],
      );
    });
  }

  private async findSessionActor(input: {
    readonly secretHash: string;
    readonly nowMs: number;
    readonly sensitiveAction: boolean;
  }): Promise<SessionActor> {
    const actor = await this.transaction<SessionActor | null>(async (client) => {
      const result = await client.query<LocalIdentitySessionRow>(
        `SELECT
           session.id AS session_id,
           identity_user.id AS user_id,
           identity_user.normalized_email,
           identity_user.status AS user_status,
           identity_user.session_version AS current_session_version,
           session.captured_session_version,
           session.status AS session_status,
           session.session_kind,
           organization.id AS organization_id,
           organization.status AS organization_status,
           membership.id AS membership_id,
           membership.status AS membership_status,
           role_binding.id AS role_binding_id,
           role_binding.role,
           session.last_seen_at,
           session.idle_expires_at,
           session.absolute_expires_at,
           session.reauthenticated_at
         FROM identity_sessions AS session
         JOIN identity_users AS identity_user ON identity_user.id = session.user_id
         JOIN access_organization_memberships AS membership
           ON membership.id = session.membership_id
          AND membership.organization_id = session.organization_id
          AND membership.user_id = session.user_id
         JOIN access_organizations AS organization ON organization.id = session.organization_id
         JOIN access_role_bindings AS role_binding
           ON role_binding.membership_id = membership.id
          AND role_binding.organization_id = membership.organization_id
          AND role_binding.user_id = membership.user_id
          AND role_binding.status = 'active'
        WHERE session.secret_hash = $1
          AND session.session_kind = 'local_synthetic'
        LIMIT 1
        FOR UPDATE OF session`,
        [secretHashBuffer(input.secretHash)],
      );
      const row = result.rows[0];
      if (!row) throw new IdentityRepositoryError("SESSION_NOT_FOUND");

      const decision = evaluateSession({
        nowMs: input.nowMs,
        sensitiveAction: input.sensitiveAction,
        userStatus: row.user_status,
        currentSessionVersion: toSafeInteger(row.current_session_version),
        sessionStatus: row.session_status,
        capturedSessionVersion: toSafeInteger(row.captured_session_version),
        organizationStatus: row.organization_status,
        membershipStatus: row.membership_status,
        idleExpiresAtMs: toMillis(row.idle_expires_at),
        absoluteExpiresAtMs: toMillis(row.absolute_expires_at),
        reauthenticatedAtMs: row.reauthenticated_at === null
          ? null
          : toMillis(row.reauthenticated_at),
      });
      if (!decision.allowed) {
        await expireOrRevokeSession(client, row.session_id, decision.code);
        return null;
      }

      const idleExpiresAtMs = Math.min(
        input.nowMs + SESSION_POLICY.idleTimeoutMs,
        toMillis(row.absolute_expires_at),
      );
      await client.query(
        `UPDATE identity_sessions
            SET last_seen_at = $2,
                idle_expires_at = $3,
                record_version = record_version + 1,
                updated_at = $2
          WHERE id = $1
            AND status = 'active'`,
        [row.session_id, new Date(input.nowMs), new Date(idleExpiresAtMs)],
      );

      return Object.freeze({
        userId: row.user_id,
        normalizedEmail: row.normalized_email,
        organizationId: row.organization_id,
        membershipId: row.membership_id,
        roleBindingId: row.role_binding_id,
        role: row.role,
        sessionId: row.session_id,
        capturedSessionVersion: toSafeInteger(row.captured_session_version),
        reauthenticatedAt: row.reauthenticated_at === null
          ? null
          : toMillis(row.reauthenticated_at),
      });
    });
    if (actor === null) throw new IdentityRepositoryError("SESSION_NOT_FOUND");
    return actor;
  }

  private async transaction<T>(operation: (client: LocalIdentityClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.organization_id', $1, true)", [
        LOCAL_SYNTHETIC_ORGANIZATION.id,
      ]);
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the owning database error without exposing rollback details.
      }
      throw error;
    } finally {
      client.release();
    }
  }
}

const globalForLocalIdentity = globalThis as typeof globalThis & {
  __txLocalIdentityPools?: Map<string, Pool>;
};

export function getPostgresqlLocalSyntheticSessionRepository(
  connectionString: string,
  timeoutMs: number,
): PostgresqlLocalSyntheticSessionRepository {
  const pools = globalForLocalIdentity.__txLocalIdentityPools ?? new Map<string, Pool>();
  globalForLocalIdentity.__txLocalIdentityPools = pools;
  let pool = pools.get(connectionString);
  if (!pool) {
    pool = new Pool({
      connectionString,
      application_name: "tianxing-local-identity-runtime",
      max: 4,
      connectionTimeoutMillis: timeoutMs,
      statement_timeout: 5_000,
      idleTimeoutMillis: 30_000,
      ssl: false,
    });
    pools.set(connectionString, pool);
  }
  return new PostgresqlLocalSyntheticSessionRepository(pool);
}

async function expireOrRevokeSession(
  client: LocalIdentityClient,
  sessionId: string,
  code: string,
): Promise<void> {
  const status = code === "SESSION_ABSOLUTE_EXPIRED" || code === "SESSION_IDLE_EXPIRED"
    ? "expired"
    : "revoked";
  await client.query(
    `UPDATE identity_sessions
        SET status = $2,
            revoked_at = CASE WHEN $2 = 'revoked' THEN transaction_timestamp() ELSE NULL END,
            revoke_reason = CASE WHEN $2 = 'revoked' THEN $3 ELSE NULL END,
            record_version = record_version + 1,
            updated_at = transaction_timestamp()
      WHERE id = $1
        AND status = 'active'`,
    [sessionId, status, code.toLowerCase()],
  );
}

function secretHashBuffer(secretHash: string): Buffer {
  if (!/^[a-f0-9]{64}$/.test(secretHash)) {
    throw new TypeError("Local synthetic session hash is invalid.");
  }
  return Buffer.from(secretHash, "hex");
}

function sanitizedReason(reason: string): string {
  const value = reason.trim();
  if (!value || value.length > 128 || /[\r\n]/.test(value)) {
    return "local_session_revoked";
  }
  return value;
}

function toSafeInteger(value: string | number): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new LocalSyntheticIdentityInvariantError();
  }
  return number;
}

function toMillis(value: Date | string): number {
  const milliseconds = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(milliseconds)) throw new LocalSyntheticIdentityInvariantError();
  return milliseconds;
}

export type { LocalIdentityPool, LocalIdentityClient };
