export interface PostgreSqlQueryResult<Row extends Record<string, unknown> = Record<string, unknown>> {
  readonly rows: readonly Row[];
  readonly rowCount: number;
}

export interface PostgreSqlTransaction {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PostgreSqlQueryResult<Row>>;
}

export interface PostgreSqlAdapter {
  transaction<T>(
    context: Readonly<{ organizationId: string; actorUserId: string }>,
    work: (transaction: PostgreSqlTransaction) => Promise<T>,
  ): Promise<T>;
}

export interface TenantQueryTransaction {
  query<Row = Record<string, unknown>>(query: {
    readonly text: string;
    readonly values?: readonly unknown[];
  }): Promise<{ readonly rows: readonly Row[]; readonly rowCount?: number | null }>;
}

export interface TenantQueryRunner {
  run<T>(
    context: Readonly<{ organizationId: string; actorUserId: string }>,
    work: (transaction: TenantQueryTransaction) => Promise<T>,
  ): Promise<T>;
}

export function createPostgreSqlAdapter(runner: TenantQueryRunner): PostgreSqlAdapter {
  return Object.freeze({
    transaction<T>(context, work): Promise<T> {
      return runner.run(context, async (transaction) => work({
        async query<Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) {
          const result = await transaction.query<Row>({ text, values });
          return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
        },
      }));
    },
  });
}

export type ProductionRepositoryErrorCode = "PRODUCTION_POSTGRES_ADAPTER_UNAVAILABLE";

export class ProductionRepositoryError extends Error {
  readonly code: ProductionRepositoryErrorCode;
  readonly httpStatus = 503 as const;
  readonly retryable = false;

  constructor(code: ProductionRepositoryErrorCode = "PRODUCTION_POSTGRES_ADAPTER_UNAVAILABLE") {
    super(`Production repository unavailable: ${code}.`);
    this.name = "ProductionRepositoryError";
    this.code = code;
  }
}

export function requirePostgreSqlAdapter(
  adapter: PostgreSqlAdapter | null | undefined,
): PostgreSqlAdapter {
  if (adapter === null || adapter === undefined) throw new ProductionRepositoryError();
  return adapter;
}
