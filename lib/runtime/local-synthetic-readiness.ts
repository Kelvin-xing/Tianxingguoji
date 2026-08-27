import "server-only";

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
import {
  loadDocumentTransportConfig,
  type DocumentTransportConfig,
} from "./document-transport-config.ts";

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
    document_transport: LocalDependencyState;
  }>;
}

export interface LocalSyntheticReadinessProbes {
  postgresql(config: LocalSyntheticConfig): Promise<void>;
  identityPostgresql(config: LocalSyntheticConfig): Promise<void>;
  applicationPostgresql(config: LocalSyntheticConfig): Promise<void>;
  documentTransport(config: DocumentTransportConfig): Promise<void>;
}

export async function checkLocalSyntheticReadiness(
  options: Readonly<{
    environment?: Environment;
    probes?: Partial<LocalSyntheticReadinessProbes>;
  }> = {},
): Promise<LocalSyntheticReadinessReport> {
  const config = loadLocalSyntheticConfig(options.environment);
  const documentConfig = loadDocumentTransportConfig(options.environment);
  const probes: LocalSyntheticReadinessProbes = Object.freeze({
    ...DEFAULT_PROBES,
    ...options.probes,
  });
  const [postgresql, postgresqlIdentity, postgresqlApplication, documentTransport] = await Promise.allSettled([
    probes.postgresql(config),
    probes.identityPostgresql(config),
    probes.applicationPostgresql(config),
    probes.documentTransport(documentConfig),
  ]);

  const dependencies = Object.freeze({
    postgresql: state(postgresql.status === "fulfilled"),
    postgresql_identity: state(postgresqlIdentity.status === "fulfilled"),
    postgresql_application: state(postgresqlApplication.status === "fulfilled"),
    document_transport: state(documentTransport.status === "fulfilled"),
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

  async documentTransport(config: DocumentTransportConfig): Promise<void> {
    if (config.mode !== "deterministic-fake") {
      throw new Error("Document transport is not enabled for local development.");
    }
  },
});

function state(ready: boolean): LocalDependencyState {
  return ready ? "ready" : "unavailable";
}
