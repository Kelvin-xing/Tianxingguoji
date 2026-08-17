import "server-only";

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
  release(): void;
}

export interface DatabasePool {
  connect(): Promise<DatabaseClient>;
}

export interface TenantDatabaseContext {
  readonly organizationId: string;
  readonly actorUserId: string;
}

export interface TenantTransaction {
  query<Row = Record<string, unknown>>(query: DatabaseQuery): Promise<DatabaseQueryResult<Row>>;
}

export interface TenantTransactionRunner {
  run<Result>(
    context: TenantDatabaseContext,
    operation: (transaction: TenantTransaction) => Promise<Result>,
  ): Promise<Result>;
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

export function createTenantTransactionRunner(pool: DatabasePool): TenantTransactionRunner {
  return Object.freeze({
    async run<Result>(
      context: TenantDatabaseContext,
      operation: (transaction: TenantTransaction) => Promise<Result>,
    ): Promise<Result> {
      assertTenantContext(context);
      const client = await pool.connect();
      let began = false;

      try {
        await client.query({ text: "BEGIN" });
        began = true;
        await client.query({
          text: "SELECT set_config('app.organization_id', $1, true)",
          values: [context.organizationId],
        });
        await client.query({
          text: "SELECT set_config('app.actor_user_id', $1, true)",
          values: [context.actorUserId],
        });
        const result = await operation(createTransaction(client));
        await client.query({ text: "COMMIT" });
        return result;
      } catch (error) {
        if (began) {
          try {
            await client.query({ text: "ROLLBACK" });
          } catch {
            // Preserve the original database or domain failure for the API contract.
          }
        }
        throw error;
      } finally {
        client.release();
      }
    },
  });
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

function assertTenantContext(context: TenantDatabaseContext): void {
  if (!UUID.test(context.organizationId) || !UUID.test(context.actorUserId)) {
    throw new TypeError("Tenant database context requires canonical UUID identifiers.");
  }
}
