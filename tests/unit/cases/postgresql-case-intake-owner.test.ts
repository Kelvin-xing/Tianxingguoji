import assert from "node:assert/strict";
import test from "node:test";

import { PostgresqlAccessCaseIntakeOwner } from "../../../modules/access/infrastructure/postgresql-case-intake-owner.ts";
import type {
  DatabaseQuery,
  DatabaseQueryResult,
  TenantTransaction,
  TenantTransactionRunner,
} from "../../../modules/shared/server.ts";

const ORGANIZATION_ID = "91000000-0000-4000-8000-000000000001";
const ACTOR_ID = "91000000-0000-4000-8000-000000000002";
const FIRST_BINDING_ID = "91000000-0000-4000-8000-000000000003";
const SECOND_BINDING_ID = "91000000-0000-4000-8000-000000000004";
const FIRST_USER_ID = "91000000-0000-4000-8000-000000000005";
const SECOND_USER_ID = "91000000-0000-4000-8000-000000000006";

test("case intake advisor options use the employee nickname and login email", async () => {
  let observedQuery = "";
  const runner: TenantTransactionRunner = Object.freeze({
    async run<Result>(
      _context: { readonly organizationId: string; readonly actorUserId: string },
      operation: (transaction: TenantTransaction) => Promise<Result>,
    ): Promise<Result> {
      return operation(Object.freeze({
        async query<Row = Record<string, unknown>>(
          query: DatabaseQuery,
        ): Promise<DatabaseQueryResult<Row>> {
          observedQuery = query.text;
          return {
            rows: [
              {
                id: FIRST_BINDING_ID,
                role: "advisor",
                user_id: FIRST_USER_ID,
                normalized_email: "advisor@example.invalid",
                display_name: "顾问甲",
              },
              {
                id: SECOND_BINDING_ID,
                role: "advisor",
                user_id: SECOND_USER_ID,
                normalized_email: "advisor-secondary@example.invalid",
                display_name: null,
              },
            ] as Row[],
            rowCount: 2,
          };
        },
      }));
    },
  });

  const result = await new PostgresqlAccessCaseIntakeOwner(runner).listAdvisors({
    organizationId: ORGANIZATION_ID,
    actorUserId: ACTOR_ID,
    query: null,
  });

  assert.deepEqual(result, [
    {
      id: FIRST_BINDING_ID,
      role: "advisor",
      displayName: "顾问甲 · advisor@example.invalid",
    },
    {
      id: SECOND_BINDING_ID,
      role: "advisor",
      displayName: "未设置昵称 · advisor-secondary@example.invalid",
    },
  ]);
  assert.match(observedQuery, /actor\.normalized_email/);
  assert.match(observedQuery, /employee_profile\.display_name/);
  assert.match(observedQuery, /ORDER BY COALESCE\(NULLIF\(BTRIM\(employee_profile\.display_name\)/);
});
