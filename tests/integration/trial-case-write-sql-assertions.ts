import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { NEON_TEST_MANIFEST_ID, NEON_TEST_ORGANIZATION, NEON_TEST_PRINCIPALS, NEON_TEST_STUDENTS } from "../../scripts/db/neon-test-synthetic-fixture.ts";

/** Called inside the read fixture transaction after explicit enrollment; every attempt rolls back. */
export async function assertTrialCaseWriteSql(client: Client): Promise<void> {
  const org = NEON_TEST_ORGANIZATION.id;
  const [founder,l1,,l2,l3] = NEON_TEST_PRINCIPALS;
  const context = async (id: string) => {
    await client.query("SELECT set_config('app.organization_id',$1,true),set_config('app.actor_user_id',$2,true)", [org,id]);
  };
  for (const [person,level,category,allowed] of [
    [founder!,"founder","international_school",true], [founder!,"founder","local_school",true],
    [l1!,"l1","international_school",true], [l1!,"l1","local_school",true],
    [l2!,"l2","international_school",true], [l2!,"l2","local_school",false],
    [l3!,"l3","international_school",false], [founder!,"founder",null,false],
  ] as const) {
    await client.query("SAVEPOINT trial_case_write");
    try {
      await context(person.userId);
      const caseId = randomUUID();
      const binding = (await client.query("SELECT id FROM access_role_bindings WHERE user_id=$1 AND role=$2 AND status='active'", [person.userId,level])).rows[0]!.id;
      const insert = () => client.query(`INSERT INTO cases_service_cases
        (id,organization_id,student_id,case_number,application_type,intake_year,admission_type,
         primary_role_binding_id,primary_membership_id,primary_user_id,primary_role,stage,
         workflow_status,record_version,current_primary_advisor_assignment_id,business_category)
        VALUES ($1,$2,$3,$4,'k12',2090,'transfer',$5,$6,$7,$8,'signed',
          'active',1,gen_random_uuid(),$9)`, [caseId,org,NEON_TEST_STUDENTS[1]!.id,
        `TRIAL-WRITE-${caseId}`,binding,person.membershipId,person.userId,level,category]);
      if (!allowed) {
        await assert.rejects(insert, (error: unknown) => (error as {code: string}).code === "42501");
        continue;
      }
      await insert();
      await client.query(`INSERT INTO cases_primary_advisor_assignments
        (id,organization_id,service_case_id,advisor_role_binding_id,membership_id,
         advisor_user_id,advisor_role,starts_at,assignment_reason)
        SELECT current_primary_advisor_assignment_id,organization_id,id,primary_role_binding_id,
          primary_membership_id,primary_user_id,primary_role,created_at,'trial_sql_fixture'
        FROM cases_service_cases WHERE id=$1`, [caseId]);
      await client.query(`INSERT INTO cases_assessments
        (id,organization_id,service_case_id,manifest_id,status,record_version)
        VALUES (gen_random_uuid(),$1,$2,$3,'draft',1)`, [org,caseId,NEON_TEST_MANIFEST_ID]);
      const advance = await client.query("SELECT * FROM cases_advance_new_service_case($1,$2,$3,transaction_timestamp())", [caseId,level,randomUUID()]);
      assert.equal(advance.rows[0]?.decision,"allowed", `${level} may advance its authorized classified case`);
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      await client.query("SET CONSTRAINTS ALL DEFERRED");
      const pause = await client.query("SELECT * FROM cases_apply_service_case_workflow_action($1,2,'pause',$2,'Synthetic pause',$3,transaction_timestamp())", [caseId,level,randomUUID()]);
      assert.equal(pause.rows[0]?.decision,"allowed");
      assert.equal(pause.rows[0]?.result_status,"paused");
      if (level === "l2") {
        await context(founder!.userId);
        await client.query("UPDATE access_trial_members SET categories='{}',record_version=record_version+1 WHERE user_id=$1", [person.userId]);
        await context(person.userId);
        const rejected = await client.query("SELECT * FROM cases_apply_service_case_workflow_action($1,3,'resume',$2,'Synthetic resume',$3,transaction_timestamp())", [caseId,level,randomUUID()]);
        assert.notEqual(rejected.rows[0]?.decision,"allowed", "revoked categories block the stored command too");
        const unchanged = await client.query("SELECT workflow_status,record_version FROM cases_service_cases WHERE id=$1", [caseId]);
        assert.equal(unchanged.rows[0]!.workflow_status,"paused");
        assert.equal(Number(unchanged.rows[0]!.record_version),3);
      }
    } finally {
      await client.query("ROLLBACK TO SAVEPOINT trial_case_write");
      await client.query("RELEASE SAVEPOINT trial_case_write");
    }
  }
  // A Founder cannot designate a category-limited employee outside that employee's scope.
  await context(founder!.userId);
  assert.equal((await client.query("SELECT cases_trial_member_can_manage($1,$2,'local_school','l2') AS allowed", [org,l2!.userId])).rows[0]!.allowed,false);
  assert.equal((await client.query("SELECT cases_trial_member_can_manage($1,$2,'international_school','founder') AS allowed", [org,l2!.userId])).rows[0]!.allowed,false);
  process.stdout.write(JSON.stringify({ trial_case_write_sql: "pass", grades: "actual", classification: "explicit", scope_revocation: "denied", workflow: "preserved" }) + "\n");
}
