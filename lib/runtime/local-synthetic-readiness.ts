import "server-only";

import { createConnection } from "node:net";

import { Client } from "pg";

import {
  loadLocalSyntheticConfig,
  type LocalSyntheticConfig,
} from "./local-synthetic-config.ts";

type Environment = Readonly<Record<string, string | undefined>>;
export type LocalDependencyState = "ready" | "unavailable";

export interface LocalSyntheticReadinessReport {
  readonly mode: "local-synthetic";
  readonly status: "ready" | "not_ready";
  readonly dependencies: Readonly<{
    postgresql: LocalDependencyState;
    postgresql_identity: LocalDependencyState;
    localstack_s3: LocalDependencyState;
    localstack_sqs: LocalDependencyState;
    clamav: LocalDependencyState;
  }>;
}

export interface LocalSyntheticReadinessProbes {
  postgresql(config: LocalSyntheticConfig): Promise<void>;
  identityPostgresql(config: LocalSyntheticConfig): Promise<void>;
  localstack(config: LocalSyntheticConfig): Promise<Readonly<{ s3: boolean; sqs: boolean }>>;
  clamav(config: LocalSyntheticConfig): Promise<void>;
}

export async function checkLocalSyntheticReadiness(
  options: Readonly<{
    environment?: Environment;
    probes?: LocalSyntheticReadinessProbes;
  }> = {},
): Promise<LocalSyntheticReadinessReport> {
  const config = loadLocalSyntheticConfig(options.environment);
  const probes = options.probes ?? DEFAULT_PROBES;
  const [postgresql, postgresqlIdentity, localstack, clamav] = await Promise.allSettled([
    probes.postgresql(config),
    probes.identityPostgresql(config),
    probes.localstack(config),
    probes.clamav(config),
  ]);

  const dependencies = Object.freeze({
    postgresql: state(postgresql.status === "fulfilled"),
    postgresql_identity: state(postgresqlIdentity.status === "fulfilled"),
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
      const result = await client.query<{ ready: number }>("SELECT 1 AS ready");
      if (result.rows[0]?.ready !== 1) {
        throw new Error("PostgreSQL readiness result was invalid.");
      }
    } finally {
      if (connected) await client.end();
    }
  },

  async identityPostgresql(config: LocalSyntheticConfig): Promise<void> {
    const client = new Client({
      connectionString: config.database.identityConnectionString,
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
      await client.query("SELECT set_config('app.organization_id', $1, true)", [
        "10000000-0000-4000-8000-000000000001",
      ]);
      const result = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM identity_users AS identity_user
           JOIN access_organization_memberships AS membership
             ON membership.user_id = identity_user.id
            AND membership.status = 'active'
           JOIN access_role_bindings AS role_binding
             ON role_binding.membership_id = membership.id
            AND role_binding.organization_id = membership.organization_id
            AND role_binding.user_id = membership.user_id
            AND role_binding.status = 'active'
          WHERE membership.organization_id = $1
            AND identity_user.status = 'active'
            AND identity_user.normalized_email LIKE '%@local.invalid'`,
        ["10000000-0000-4000-8000-000000000001"],
      );
      await client.query("SELECT session_kind FROM identity_sessions LIMIT 0");
      if (Number(result.rows[0]?.count) !== 5) {
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
