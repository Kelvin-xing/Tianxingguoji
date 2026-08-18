import assert from "node:assert/strict";
import test from "node:test";

import {
  ApplicationDatabaseRoleError,
  createTenantTransactionRunner,
  type DatabaseClient,
  type DatabaseQuery,
} from "../../../modules/shared/infrastructure/db.ts";

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const USER_ID = "10000000-0000-4000-8000-000000000002";

test("preflights the URL login and inherited application group inside every transaction", async () => {
  const client = new FakeClient("env01_application_login", true);
  const runner = createTenantTransactionRunner({ connect: async () => client }, {
    expectedLoginUser: "env01_application_login",
    requiredGroupRole: "tianxing_test_application",
  });

  const result = await runner.run(
    { organizationId: ORGANIZATION_ID, actorUserId: USER_ID },
    async (transaction) => {
      await transaction.query({ text: "SELECT 1" });
      return "ok";
    },
  );

  assert.equal(result, "ok");
  assert.deepEqual(client.queries.map(({ text }) => text.trim().split("\n")[0]), [
    "BEGIN",
    "SELECT current_user,",
    "SELECT set_config('app.organization_id', $1, true)",
    "SELECT set_config('app.actor_user_id', $1, true)",
    "SELECT 1",
    "COMMIT",
  ]);
  assert.equal(client.released, true);
});

test("rolls back before tenant context when the login is not a member of the group", async () => {
  const client = new FakeClient("wrong_login", false);
  const runner = createTenantTransactionRunner({ connect: async () => client }, {
    expectedLoginUser: "env01_application_login",
    requiredGroupRole: "tianxing_test_application",
  });

  await assert.rejects(
    runner.run(
      { organizationId: ORGANIZATION_ID, actorUserId: USER_ID },
      async () => "unreachable",
    ),
    ApplicationDatabaseRoleError,
  );
  assert.deepEqual(client.queries.map(({ text }) => text.trim().split("\n")[0]), [
    "BEGIN",
    "SELECT current_user,",
    "ROLLBACK",
  ]);
});

class FakeClient implements DatabaseClient {
  readonly queries: DatabaseQuery[] = [];
  released = false;
  private readonly currentUser: string;
  private readonly hasRole: boolean;

  constructor(currentUser: string, hasRole: boolean) {
    this.currentUser = currentUser;
    this.hasRole = hasRole;
  }

  async query<Row>(query: DatabaseQuery) {
    this.queries.push(query);
    if (query.text.includes("pg_has_role")) {
      return {
        rows: [{ current_user: this.currentUser, has_required_role: this.hasRole }] as Row[],
      };
    }
    return { rows: [] as Row[] };
  }

  release(): void {
    this.released = true;
  }
}
