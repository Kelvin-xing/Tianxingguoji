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
const REQUEST_ID = "p1-be-01-request";

test("preflights the canonical URL login inside every transaction", async () => {
  const client = new FakeClient("tianxing_app");
  const runner = createTenantTransactionRunner({ connect: async () => client }, {
    expectedLoginUser: "tianxing_app",
  });

  const result = await runner.run(
    {
      organizationId: ORGANIZATION_ID,
      actorKind: "user",
      actorOpaqueId: USER_ID,
      requestId: REQUEST_ID,
      correlationId: "p1-be-01-correlation",
    },
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
    "SELECT set_config('app.actor_kind', $1, true)",
    "SELECT set_config('app.actor_opaque_id', $1, true)",
    "SELECT set_config('app.actor_user_id', $1, true)",
    "SELECT set_config('app.request_id', $1, true)",
    "SELECT set_config('app.correlation_id', $1, true)",
    "SELECT set_config('app.causation_id', $1, true)",
    "SELECT 1",
    "SET CONSTRAINTS ALL IMMEDIATE",
    "SELECT set_config('app.organization_id', $1, true)",
    "SELECT set_config('app.actor_kind', $1, true)",
    "SELECT set_config('app.actor_opaque_id', $1, true)",
    "SELECT set_config('app.actor_user_id', $1, true)",
    "SELECT set_config('app.request_id', $1, true)",
    "SELECT set_config('app.correlation_id', $1, true)",
    "SELECT set_config('app.causation_id', $1, true)",
    "COMMIT",
    "RESET app.organization_id",
    "RESET app.actor_kind",
    "RESET app.actor_opaque_id",
    "RESET app.actor_user_id",
    "RESET app.request_id",
    "RESET app.correlation_id",
    "RESET app.causation_id",
  ]);
  assert.equal(client.released, true);
  assert.equal(
    client.queries.filter(({ text }) => text.includes("set_config('app.causation_id'"))
      .at(-1)?.values?.[0],
    "",
  );
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
    "RESET app.organization_id",
    "RESET app.actor_kind",
    "RESET app.actor_opaque_id",
    "RESET app.actor_user_id",
    "RESET app.request_id",
    "RESET app.correlation_id",
    "RESET app.causation_id",
  ]);
});

class FakeClient implements DatabaseClient {
  readonly queries: DatabaseQuery[] = [];
  released = false;
  releaseError: Error | undefined;
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

  release(error?: Error): void {
    this.released = true;
    this.releaseError = error;
  }
}

test("deferred constraints run with tenant context and failures roll back before clearing it", async () => {
  const failure=new Error("Synthetic deferred invariant failure");
  class DeferredFailureClient extends FakeClient {
    async query<Row>(query:DatabaseQuery) {
      if(query.text==="SET CONSTRAINTS ALL IMMEDIATE") {
        this.queries.push(query);
        assert.equal(this.queries.findLast(item=>item.text.includes("set_config('app.organization_id'"))?.values?.[0],ORGANIZATION_ID);
        assert.equal(this.queries.findLast(item=>item.text.includes("set_config('app.actor_user_id'"))?.values?.[0],USER_ID);
        throw failure;
      }
      return super.query<Row>(query);
    }
  }
  const client=new DeferredFailureClient("tianxing_app");
  const runner=createTenantTransactionRunner({connect:async()=>client},{expectedLoginUser:"tianxing_app"});
  await assert.rejects(runner.run({organizationId:ORGANIZATION_ID,actorUserId:USER_ID},async()=>"not committed"),error=>error===failure);
  assert.equal(client.queries.some(query=>query.text==="COMMIT"),false);
  assert.equal(client.queries.some(query=>query.text==="ROLLBACK"),true);
  assert.equal(client.queries.some(query=>query.text==="RESET app.organization_id"),true);
  assert.equal(client.released,true);
});
