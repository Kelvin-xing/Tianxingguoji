import "server-only";

import { createConnection } from "node:net";

import { Client } from "pg";

import {
  NEON_TEST_ORGANIZATION,
  NEON_TEST_PRINCIPALS,
  NEON_TEST_STUDENTS,
} from "../../scripts/db/neon-test-synthetic-fixture.ts";

import {
  loadLocalSyntheticConfig,
  type LocalSyntheticConfig,
} from "./local-synthetic-config.ts";

type Environment = Readonly<Record<string, string | undefined>>;
const RELEASE1_FOUNDER = NEON_TEST_PRINCIPALS.find(({ role }) => role === "founder");
if (!RELEASE1_FOUNDER) throw new Error("Release 1 synthetic founder is required.");
export type LocalDependencyState = "ready" | "unavailable";

export interface LocalSyntheticReadinessReport {
  readonly mode: "local-synthetic";
  readonly status: "ready" | "not_ready";
  readonly dependencies: Readonly<{
    postgresql: LocalDependencyState;
    postgresql_identity: LocalDependencyState;
    postgresql_application: LocalDependencyState;
    localstack_s3: LocalDependencyState;
    localstack_sqs: LocalDependencyState;
    clamav: LocalDependencyState;
  }>;
}

export interface LocalSyntheticReadinessProbes {
  postgresql(config: LocalSyntheticConfig): Promise<void>;
  identityPostgresql(config: LocalSyntheticConfig): Promise<void>;
  applicationPostgresql(config: LocalSyntheticConfig): Promise<void>;
  localstack(config: LocalSyntheticConfig): Promise<Readonly<{ s3: boolean; sqs: boolean }>>;
  clamav(config: LocalSyntheticConfig): Promise<void>;
}

export async function checkLocalSyntheticReadiness(
  options: Readonly<{
    environment?: Environment;
    probes?: Partial<LocalSyntheticReadinessProbes>;
  }> = {},
): Promise<LocalSyntheticReadinessReport> {
  const config = loadLocalSyntheticConfig(options.environment);
  const probes: LocalSyntheticReadinessProbes = Object.freeze({
    ...DEFAULT_PROBES,
    ...options.probes,
  });
  const [postgresql, postgresqlIdentity, postgresqlApplication, localstack, clamav] = await Promise.allSettled([
    probes.postgresql(config),
    probes.identityPostgresql(config),
    probes.applicationPostgresql(config),
    probes.localstack(config),
    probes.clamav(config),
  ]);

  const dependencies = Object.freeze({
    postgresql: state(postgresql.status === "fulfilled"),
    postgresql_identity: state(postgresqlIdentity.status === "fulfilled"),
    postgresql_application: state(postgresqlApplication.status === "fulfilled"),
    localstack_s3: state(localstack.status === "fulfilled" && localstack.value.s3),
    localstack_sqs: state(localstack.status === "fulfilled" && localstack.value.sqs),
    clamav: state(clamav.status === "fulfilled"),
  });
  const ready = Object.values(dependencies).every((dependency) => dependency === "ready");

  return Object.freeze({
    mode: config.mode,
    status: ready ? "ready" : "not_ready",
    dependencies,
  });
}

const DEFAULT_PROBES: LocalSyntheticReadinessProbes = Object.freeze({
  async postgresql(config: LocalSyntheticConfig): Promise<void> {
    const client = new Client({
      connectionString: config.database.connectionString,
      application_name: "tianxing-local-readiness",
      connectionTimeoutMillis: config.dependencyTimeoutMs,
      query_timeout: config.dependencyTimeoutMs,
      ssl: false,
    });
    let connected = false;
    try {
      await client.connect();
      connected = true;
      const result = await client.query<{ ready: number; current_user: string }>(
        "SELECT 1 AS ready, current_user",
      );
      if (result.rows[0]?.ready !== 1 || result.rows[0]?.current_user !== "tianxing_app") {
        throw new Error("PostgreSQL readiness result was invalid.");
      }
    } finally {
      if (connected) await client.end();
    }
  },

  async identityPostgresql(config: LocalSyntheticConfig): Promise<void> {
    const client = new Client({
      connectionString: config.database.connectionString,
      application_name: "tianxing-local-identity-readiness",
      connectionTimeoutMillis: config.dependencyTimeoutMs,
      query_timeout: config.dependencyTimeoutMs,
      ssl: false,
    });
    let connected = false;
    let transaction = false;
    try {
      await client.connect();
      connected = true;
      await client.query("BEGIN");
      transaction = true;
      await client.query(
        `SELECT current_user,
                set_config('app.organization_id', $1, true),
                set_config('app.actor_user_id', $2, true)`,
        [NEON_TEST_ORGANIZATION.id, RELEASE1_FOUNDER.userId],
      );
      const identity = await client.query<{ current_user: string }>("SELECT current_user");
      const result = await client.query<{ count: string }>(
        `WITH expected_principals(user_id, normalized_email, organization_role) AS (
           SELECT *
             FROM unnest($2::uuid[], $3::text[], $4::text[])
         )
         SELECT count(*)::text AS count
           FROM expected_principals AS expected
           JOIN identity_users AS identity_user
             ON identity_user.id = expected.user_id
            AND identity_user.normalized_email = expected.normalized_email
           JOIN access_organization_memberships AS membership
             ON membership.user_id = identity_user.id
            AND membership.status = 'active'
           JOIN access_role_bindings AS role_binding
             ON role_binding.membership_id = membership.id
            AND role_binding.organization_id = membership.organization_id
            AND role_binding.user_id = membership.user_id
            AND role_binding.status = 'active'
            AND role_binding.role = expected.organization_role
          WHERE membership.organization_id = $1
            AND identity_user.status = 'active'`,
        [
          NEON_TEST_ORGANIZATION.id,
          NEON_TEST_PRINCIPALS.map(({ userId }) => userId),
          NEON_TEST_PRINCIPALS.map(({ email }) => email),
          NEON_TEST_PRINCIPALS.map(({ role }) => role),
        ],
      );
      await client.query("SELECT session_kind FROM identity_sessions LIMIT 0");
      if (
        identity.rows[0]?.current_user !== "tianxing_app" ||
        Number(result.rows[0]?.count) !== NEON_TEST_PRINCIPALS.length
      ) {
        throw new Error("Local identity readiness result was invalid.");
      }
      await client.query("ROLLBACK");
      transaction = false;
    } finally {
      if (transaction) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Preserve the readiness failure without exposing rollback details.
        }
      }
      if (connected) await client.end();
    }
  },

  async applicationPostgresql(config: LocalSyntheticConfig): Promise<void> {
    const client = new Client({
      connectionString: config.database.connectionString,
      application_name: "tianxing-local-application-readiness",
      connectionTimeoutMillis: config.dependencyTimeoutMs,
      query_timeout: config.dependencyTimeoutMs,
      ssl: false,
    });
    let connected = false;
    let transaction = false;
    try {
      await client.connect();
      connected = true;
      await client.query("BEGIN");
      transaction = true;
      await client.query(
        `SELECT current_user,
                set_config('app.organization_id', $1, true),
                set_config('app.actor_user_id', $2, true)`,
        [NEON_TEST_ORGANIZATION.id, RELEASE1_FOUNDER.userId],
      );
      const identity = await client.query<{ current_user: string }>("SELECT current_user");
      const result = await client.query<{
        students: number;
        manifests: number;
      }>(
        `SELECT (SELECT count(*)::int
                   FROM crm_students
                  WHERE id = ANY($1::uuid[])
                    AND status = 'active') AS students,
                (SELECT count(*)::int FROM cases_list_approved_manifests()) AS manifests`,
        [NEON_TEST_STUDENTS.map(({ id }) => id)],
      );
      if (
        identity.rows[0]?.current_user !== "tianxing_app" ||
        result.rows[0]?.students !== NEON_TEST_STUDENTS.length ||
        result.rows[0]?.manifests !== 1
      ) {
        throw new Error("Local application readiness result was invalid.");
      }
      await client.query("ROLLBACK");
      transaction = false;
    } finally {
      if (transaction) await client.query("ROLLBACK").catch(() => undefined);
      if (connected) await client.end();
    }
  },

  async localstack(
    config: LocalSyntheticConfig,
  ): Promise<Readonly<{ s3: boolean; sqs: boolean }>> {
    const response = await fetch(`${config.localstack.endpoint}/_localstack/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(config.dependencyTimeoutMs),
    });
    if (!response.ok) throw new Error("LocalStack health request failed.");
    const payload: unknown = await response.json();
    const services = record(payload)?.services;
    const serviceRecord = record(services);
    return Object.freeze({
      s3: localstackServiceReady(serviceRecord?.s3),
      sqs: localstackServiceReady(serviceRecord?.sqs),
    });
  },

  clamav(config: LocalSyntheticConfig): Promise<void> {
    return probeClamav(config.clamav.host, config.clamav.port, config.dependencyTimeoutMs);
  },
});

function probeClamav(host: string, port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    let settled = false;
    let reply = Buffer.alloc(0);

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };

    socket.setTimeout(timeoutMs, () => finish(new Error("ClamAV readiness timed out.")));
    socket.once("connect", () => socket.write(Buffer.from("zPING\0", "utf8")));
    socket.on("data", (chunk) => {
      reply = Buffer.concat([reply, chunk]);
      if (reply.length > 64) {
        finish(new Error("ClamAV readiness response was too large."));
        return;
      }
      const terminator = reply.indexOf(0);
      if (terminator < 0) return;
      const response = reply.subarray(0, terminator).toString("utf8");
      finish(response === "PONG" ? undefined : new Error("ClamAV readiness result was invalid."));
    });
    socket.once("error", (error) => finish(error));
    socket.once("close", () => finish(new Error("ClamAV closed the readiness connection.")));
  });
}

function localstackServiceReady(value: unknown): boolean {
  return value === "available" || value === "running" || value === "ready";
}

function state(ready: boolean): LocalDependencyState {
  return ready ? "ready" : "unavailable";
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
