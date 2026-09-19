import assert from "node:assert/strict";
import { Client, type ClientConfig } from "pg";
import { NEON_TEST_ORGANIZATION, NEON_TEST_PRINCIPALS } from "../../scripts/db/neon-test-synthetic-fixture.ts";

/** Uses the disposable PG17 baseline, single seeded organization and a separate connection. */
export async function assertTrialAccessSchema(config: ClientConfig): Promise<void> {
  const client = new Client(config);
  const founder = NEON_TEST_PRINCIPALS.find((p) => p.role === "founder")!;
  const advisor = NEON_TEST_PRINCIPALS.find((p) => p.role === "advisor")!;
  const org = NEON_TEST_ORGANIZATION.id;
  const context = async (actor: string) => {
    await client.query("SELECT set_config('app.organization_id',$1,true),set_config('app.actor_user_id',$2,true)", [org, actor]);
  };
  const rejected = async (sql: string, values: unknown[], code: string) => {
    await client.query("SAVEPOINT rejected_trial_command");
    await assert.rejects(client.query(sql, values), (error: unknown) =>
      (error as { code: string }).code === code);
    await client.query("ROLLBACK TO SAVEPOINT rejected_trial_command");
  };
  const insert = `INSERT INTO access_trial_members
    (membership_id,organization_id,user_id,level,categories,created_by_user_id,updated_by_user_id)
    VALUES ($1,$2,$3,$4,$5,$6,$6)`;
  try {
    await client.connect();
    await client.query("BEGIN");
    await context(founder.userId);
    assert.equal((await client.query("SELECT count(*)::int AS n FROM access_trial_members")).rows[0].n, 0,
      "migration must not assign levels automatically");
    await context(advisor.userId);
    await rejected(insert, [advisor.membershipId, org, advisor.userId, "founder", [], advisor.userId], "42501");
    await context(founder.userId);
    await client.query(insert, [founder.membershipId, org, founder.userId, "founder", [], founder.userId]);
    await client.query(insert, [advisor.membershipId, org, advisor.userId, "l2", ["international_school"], founder.userId]);
    await rejected("SET CONSTRAINTS ALL IMMEDIATE", [], "23514");
    const timing=(await client.query("SELECT transaction_timestamp()<created_at AS transaction_predates_binding,clock_timestamp()<created_at AS clock_predates_binding FROM access_role_bindings WHERE id=$1",[advisor.roleBindingId])).rows[0];
    process.stdout.write(JSON.stringify({trial_binding_clock:timing})+'\n');
    await client.query("UPDATE access_role_bindings SET status='revoked',record_version=record_version+1 WHERE id=$1", [advisor.roleBindingId]);
    await client.query(`INSERT INTO access_role_bindings
      (id,organization_id,membership_id,user_id,role,status,created_by_user_id)
      VALUES (gen_random_uuid(),$1,$2,$3,'l2','active',$4)`, [org,advisor.membershipId,advisor.userId,founder.userId]);
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    const workspace = await client.query("SELECT role FROM access_resolve_workspace_context($1,$2,$3)", [advisor.userId,org,advisor.membershipId]);
    assert.deepEqual(workspace.rows, [{ role: "l2" }]);
    // A transaction can observe a binding newer than its start timestamp (READ COMMITTED),
    // and a host clock adjustment can produce the same ordering. Revocation must remain valid.
    await client.query('SAVEPOINT binding_timestamp_order');
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    await client.query("UPDATE access_role_bindings SET status='revoked',record_version=record_version+1 WHERE user_id=$1 AND status='active'",[advisor.userId]);
    const futureBinding=(await client.query(`INSERT INTO access_role_bindings
      (id,organization_id,membership_id,user_id,role,status,created_by_user_id,created_at,updated_at)
      VALUES(gen_random_uuid(),$1,$2,$3,'l2','active',$4,transaction_timestamp()+interval '2 seconds',transaction_timestamp()+interval '2 seconds') RETURNING id`,
      [org,advisor.membershipId,advisor.userId,founder.userId])).rows[0].id;
    await client.query("UPDATE access_role_bindings SET status='revoked',record_version=record_version+1 WHERE id=$1",[futureBinding]);
    const preserved=(await client.query('SELECT updated_at>=created_at AS ordered,status FROM access_role_bindings WHERE id=$1',[futureBinding])).rows[0];
    assert.deepEqual(preserved,{ordered:true,status:'revoked'});
    await client.query('ROLLBACK TO SAVEPOINT binding_timestamp_order');await client.query('RELEASE SAVEPOINT binding_timestamp_order');
    const read = await client.query("SELECT * FROM access_resolve_trial_principal($1,$2,$3)", [advisor.userId, org, advisor.membershipId]);
    assert.equal(read.rows[0].level, "l2");
    assert.deepEqual(read.rows[0].categories, ["international_school"]);
    assert.equal(read.rows[0].active, true);
    await rejected("UPDATE access_trial_members SET categories=ARRAY['unknown'],record_version=2 WHERE user_id=$1", [advisor.userId], "23514");
    await rejected("UPDATE access_trial_members SET level='l1' WHERE user_id=$1", [advisor.userId], "23514");
    await rejected("UPDATE access_trial_members SET level='l1',record_version=2 WHERE user_id=$1", [founder.userId], "23514");
    await rejected("DELETE FROM access_trial_members WHERE user_id=$1", [advisor.userId], "23514");
    await rejected("TRUNCATE access_trial_members", [], "23514");
    await context(advisor.userId);
    await rejected("UPDATE access_trial_members SET level='founder',categories='{}',record_version=2,updated_by_user_id=$1 WHERE user_id=$1", [advisor.userId], "42501");
    await context(founder.userId);
    await client.query("UPDATE access_trial_members SET categories='{}',record_version=2 WHERE user_id=$1", [advisor.userId]);
    const revoked = await client.query("SELECT * FROM access_resolve_trial_principal($1,$2,$3)", [advisor.userId, org, advisor.membershipId]);
    assert.deepEqual(revoked.rows[0].categories, []);
    assert.equal(Number(revoked.rows[0].record_version), 2);
    await client.query("SELECT set_config('app.organization_id','',true)");
    assert.equal((await client.query("SELECT * FROM access_trial_members")).rowCount, 0, "RLS fails closed without context");
    await client.query("ROLLBACK");
    await client.query("BEGIN");
    await context(founder.userId);
    assert.equal((await client.query("SELECT count(*)::int AS n FROM access_trial_members")).rows[0].n, 0, "rollback removes all trial fixture changes");
    await client.query("ROLLBACK");
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end();
  }
}
