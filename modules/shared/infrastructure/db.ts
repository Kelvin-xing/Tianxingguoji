import "server-only";

import type { IdempotencyActorKind } from "../domain/idempotency.ts";

export const APPLICATION_DATABASE_ROLE = "tianxing_app" as const;

const RDS_HONG_KONG_HOSTNAME = /^[a-z0-9][a-z0-9.-]*\.ap-east-1\.rds\.amazonaws\.com$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ApplicationDatabaseConfig = Readonly<{
  host: string;
  port: 5432;
  database: "tianxing";
  user: typeof APPLICATION_DATABASE_ROLE;
  applicationName: "tianxing-application";
  ssl: Readonly<{ rejectUnauthorized: true }>;
}>;

export type ApplicationDatabaseConfigErrorCode =
  | "DATABASE_HOST_INVALID"
  | "DATABASE_NAME_INVALID"
  | "DATABASE_PORT_INVALID";

export class ApplicationDatabaseConfigError extends Error {
  readonly code: ApplicationDatabaseConfigErrorCode;

  constructor(code: ApplicationDatabaseConfigErrorCode) {
    super(`Application database configuration rejected ${code}.`);
    this.name = "ApplicationDatabaseConfigError";
    this.code = code;
  }
}

export interface DatabaseQuery {
  readonly text: string;
  readonly values?: readonly unknown[];
}

export interface DatabaseQueryResult<Row> {
  readonly rows: readonly Row[];
  readonly rowCount?: number | null;
}

export interface DatabaseClient {
  query<Row = Record<string, unknown>>(query: DatabaseQuery): Promise<DatabaseQueryResult<Row>>;
  release(error?: Error): void;
}

export interface DatabasePool {
  connect(): Promise<DatabaseClient>;
}

export interface ActorScopedTenantDatabaseContext {
  readonly organizationId: string;
  readonly actorKind: IdempotencyActorKind;
  readonly actorOpaqueId: string;
  readonly requestId: string;
  readonly correlationId?: string;
  readonly causationId?: string;
  readonly actorUserId?: string;
}

export interface TenantDatabaseContext {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly actorKind?: never;
  readonly actorOpaqueId?: never;
  readonly requestId?: string;
  readonly correlationId?: string;
  readonly causationId?: string;
}

export type TenantTransactionContext =
  | ActorScopedTenantDatabaseContext
  | TenantDatabaseContext;

export interface TenantTransaction {
  query<Row = Record<string, unknown>>(query: DatabaseQuery): Promise<DatabaseQueryResult<Row>>;
}

export interface TenantTransactionRunner {
  run<Result>(
    context: TenantTransactionContext,
    operation: (transaction: TenantTransaction) => Promise<Result>,
  ): Promise<Result>;
}

export interface TenantTransactionRunnerOptions {
  readonly expectedLoginUser: string;
}

export class ApplicationDatabaseRoleError extends Error {
  constructor() {
    super("Application database login role is not authorized.");
    this.name = "ApplicationDatabaseRoleError";
  }
}

export function loadApplicationDatabaseConfig(
  environment: Readonly<Record<string, string | undefined>>,
): ApplicationDatabaseConfig {
  const host = environment.DATABASE_HOST?.trim().toLowerCase();
  if (!host || !RDS_HONG_KONG_HOSTNAME.test(host)) {
    throw new ApplicationDatabaseConfigError("DATABASE_HOST_INVALID");
  }

  if (environment.DATABASE_NAME !== "tianxing") {
    throw new ApplicationDatabaseConfigError("DATABASE_NAME_INVALID");
  }

  const port = environment.DATABASE_PORT ?? "5432";
  if (port !== "5432") {
    throw new ApplicationDatabaseConfigError("DATABASE_PORT_INVALID");
  }

  return Object.freeze({
    host,
    port: 5432,
    database: "tianxing",
    user: APPLICATION_DATABASE_ROLE,
    applicationName: "tianxing-application",
    ssl: Object.freeze({ rejectUnauthorized: true }),
  });
}

export function createTenantTransactionRunner(
  pool: DatabasePool,
  options?: TenantTransactionRunnerOptions,
): TenantTransactionRunner {
  return Object.freeze({
    async run<Result>(
      context: TenantTransactionContext,
      operation: (transaction: TenantTransaction) => Promise<Result>,
    ): Promise<Result> {
      assertTenantContext(context);
      const client = await pool.connect();
      let began = false;
      let releaseError: Error | undefined;

      try {
        await client.query({ text: "BEGIN" });
        began = true;
        if (options) await assertDatabaseRole(client, options);
        await setTenantContext(client, resolveTenantContext(context));
        const result = await operation(createTransaction(client));
        await clearTenantContext(client);
        await client.query({ text: "COMMIT" });
        began = false;
        await resetTenantContext(client);
        return result;
      } catch (error) {
        if (began) {
          try {
            await client.query({ text: "ROLLBACK" });
          } catch (rollbackError) {
            releaseError = toError(rollbackError);
            // Preserve the original database or domain failure for the API contract.
          }
        }
        try {
          await resetTenantContext(client);
        } catch (cleanupError) {
          releaseError ??= toError(cleanupError);
        }
        throw error;
      } finally {
        client.release(releaseError);
      }
    },
  });
}

async function assertDatabaseRole(
  client: DatabaseClient,
  options: TenantTransactionRunnerOptions,
): Promise<void> {
  const result = await client.query<{ current_user: string }>({
    text: "SELECT current_user",
  });
  const row = result.rows[0];
  if (row?.current_user !== options.expectedLoginUser) {
    throw new ApplicationDatabaseRoleError();
  }
}

function createTransaction(client: DatabaseClient): TenantTransaction {
  return Object.freeze({
    query<Row = Record<string, unknown>>(query: DatabaseQuery): Promise<DatabaseQueryResult<Row>> {
      if (query.text.trim().length === 0) {
        throw new TypeError("Database queries must contain SQL text.");
      }
      return client.query<Row>(query);
    },
  });
}

function assertTenantContext(context: TenantTransactionContext): void {
  resolveTenantContext(context);
}

type ResolvedTenantContext = Readonly<{
  organizationId: string;
  actorKind: IdempotencyActorKind;
  actorOpaqueId: string;
  actorUserId: string;
  requestId: string;
  correlationId: string;
  causationId: string;
}>;

const SAFE_OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function resolveTenantContext(context: TenantTransactionContext): ResolvedTenantContext {
  if (!UUID.test(context.organizationId)) {
    throw new TypeError("Tenant database context requires a canonical organization UUID.");
  }

  if (context.actorKind === undefined) {
    if (!UUID.test(context.actorUserId)) {
      throw new TypeError("Legacy tenant context requires a canonical User UUID.");
    }
    return Object.freeze({
      organizationId: context.organizationId,
      actorKind: "user",
      actorOpaqueId: context.actorUserId,
      actorUserId: context.actorUserId,
      requestId: validateOptionalOpaque(context.requestId),
      correlationId: validateOptionalOpaque(context.correlationId),
      causationId: validateOptionalOpaque(context.causationId),
    });
  }

  if (
    !["user", "portal", "worker", "system"].includes(context.actorKind) ||
    !SAFE_OPAQUE_ID.test(context.actorOpaqueId) ||
    !SAFE_OPAQUE_ID.test(context.requestId)
  ) {
    throw new TypeError("Actor-scoped tenant context contains an invalid opaque identifier.");
  }
  if (
    context.actorKind === "user" &&
    (!UUID.test(context.actorOpaqueId) ||
      (context.actorUserId !== undefined && context.actorUserId !== context.actorOpaqueId))
  ) {
    throw new TypeError("User actor scope must use the actual User UUID.");
  }
  if (context.actorKind !== "user" && context.actorUserId !== undefined) {
    throw new TypeError("Non-user actor scope cannot carry a User identifier.");
  }
  return Object.freeze({
    organizationId: context.organizationId,
    actorKind: context.actorKind,
    actorOpaqueId: context.actorOpaqueId,
    actorUserId: context.actorKind === "user" ? context.actorOpaqueId : "",
    requestId: context.requestId,
    correlationId: validateOptionalOpaque(context.correlationId),
    causationId: validateOptionalOpaque(context.causationId),
  });
}

async function setTenantContext(
  client: DatabaseClient,
  context: ResolvedTenantContext,
): Promise<void> {
  await setLocal(client, "app.organization_id", context.organizationId);
  await setLocal(client, "app.actor_kind", context.actorKind);
  await setLocal(client, "app.actor_opaque_id", context.actorOpaqueId);
  await setLocal(client, "app.actor_user_id", context.actorUserId);
  await setLocal(client, "app.request_id", context.requestId);
  await setLocal(client, "app.correlation_id", context.correlationId);
  await setLocal(client, "app.causation_id", context.causationId);
}

async function clearTenantContext(client: DatabaseClient): Promise<void> {
  for (const setting of [
    "app.organization_id",
    "app.actor_kind",
    "app.actor_opaque_id",
    "app.actor_user_id",
    "app.request_id",
    "app.correlation_id",
    "app.causation_id",
  ]) {
    await setLocal(client, setting, "");
  }
}

async function resetTenantContext(client: DatabaseClient): Promise<void> {
  for (const setting of [
    "app.organization_id",
    "app.actor_kind",
    "app.actor_opaque_id",
    "app.actor_user_id",
    "app.request_id",
    "app.correlation_id",
    "app.causation_id",
  ]) {
    await client.query({ text: `RESET ${setting}` });
  }
}

function setLocal(client: DatabaseClient, setting: string, value: string) {
  return client.query({
    text: `SELECT set_config('${setting}', $1, true)`,
    values: [value],
  });
}

function validateOptionalOpaque(value: string | undefined): string {
  if (value === undefined) return "";
  if (!SAFE_OPAQUE_ID.test(value)) {
    throw new TypeError("Tenant database context contains an invalid propagated identifier.");
  }
  return value;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error("Database rollback failed.");
}
