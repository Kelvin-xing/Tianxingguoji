import "server-only";

import type { TenantTransactionRunner } from "../../shared/server.ts";
import { type ResolvedSchoolTargetView } from "../application/resolved-view.ts";
import { PostgresqlResolvedSchoolTransaction } from "./postgresql-resolved-view-transaction.ts";

/**
 * Reads the currently active, resolved School directory for the local
 * synthetic composition (and the future approved PostgreSQL composition).
 * The repository never reads crawler files or creates a fallback snapshot.
 */
export class PostgresqlSchoolDirectoryRepository {
  private readonly resolved = new PostgresqlResolvedSchoolTransaction();
  private readonly runner: TenantTransactionRunner;

  constructor(runner: TenantTransactionRunner) {
    this.runner = runner;
  }

  async list(input: Readonly<{
    readonly organizationId: string;
    readonly actorUserId: string;
  }>): Promise<readonly ResolvedSchoolTargetView[]> {
    return this.runner.run(input, async (transaction) =>
      this.resolved.listCurrentResolvedSchools({
        organizationId: input.organizationId,
        transaction: {
          query<Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) {
            return transaction.query<Row>({ text, values }).then((result) => ({
              rows: result.rows,
              rowCount: result.rowCount ?? result.rows.length,
            }));
          },
        },
      }),
    );
  }
}
