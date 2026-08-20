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

test("preflights the canonical URL login inside every transaction", async () => {
  const client = new FakeClient("tianxing_app");
  const runner = createTenantTransactionRunner({ connect: async () => client }, {
    expectedLoginUser: "tianxing_app",
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
    "SELECT current_user",
    "SELECT set_config('app.organization_id', $1, true)",
    "SELECT set_config('app.actor_user_id', $1, true)",
    "SELECT 1",
    "COMMIT",
  ]);
  assert.equal(client.released, true);
});

test("rolls back before tenant context when the login is not canonical", async () => {
  const client = new FakeClient("wrong_login");
  const runner = createTenantTransactionRunner({ connect: async () => client }, {
    expectedLoginUser: "tianxing_app",
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
    "SELECT current_user",
    "ROLLBACK",
  ]);
});

class FakeClient implements DatabaseClient {
  readonly queries: DatabaseQuery[] = [];
  released = false;
  private readonly currentUser: string;

  constructor(currentUser: string) {
    this.currentUser = currentUser;
  }

  async query<Row>(query: DatabaseQuery) {
    this.queries.push(query);
    if (query.text.includes("SELECT current_user")) {
      return { rows: [{ current_user: this.currentUser }] as Row[] };
    }
    return { rows: [] as Row[] };
  }

  release(): void {
    this.released = true;
  }
}
