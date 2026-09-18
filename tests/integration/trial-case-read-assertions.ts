import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client, type ClientConfig } from "pg";
import { PostgresqlCaseWorkspaceRepository } from "../../modules/cases/infrastructure/postgresql-workspace-repository.ts";
import { buildAccessContext } from "../../modules/access/public.ts";
import { CaseWorkspaceError, CaseWorkspaceService, CaseWorkspaceRepositoryError } from "../../modules/cases/application/workspace-service.ts";
import type { PostgreSqlAdapter } from "../../modules/cases/infrastructure/postgresql.ts";
import {
  NEON_TEST_MANIFEST_ID, NEON_TEST_ORGANIZATION, NEON_TEST_PRINCIPALS, NEON_TEST_STUDENTS,
} from "../../scripts/db/neon-test-synthetic-fixture.ts";

/** Real repository reads inside a rolled-back fixture transaction, using the app login and RLS. */
export async function assertTrialCaseReads(config: ClientConfig): Promise<void> {
  const client = new Client(config);
  const org = NEON_TEST_ORGANIZATION.id;
  const [founder, l1, advisor, l2, l3] = NEON_TEST_PRINCIPALS;
  const context = async (id: string) => {
    await client.query("SELECT set_config('app.organization_id',$1,true),set_config('app.actor_user_id',$2,true)", [org,id]);
  };
  const adapter: PostgreSqlAdapter = {
    async transaction(input, work) {
      await context(input.actorUserId);
      return work({ async query(text, values) {
        const result = await client.query(text, values ? [...values] : undefined);
        return { rows: result.rows, rowCount: result.rowCount ?? 0 };
      } });
    },
  };
  const repository = new PostgresqlCaseWorkspaceRepository(adapter);
  const service = new CaseWorkspaceService(repository);
  const cachedL2 = buildAccessContext({
    userId: l2!.userId, organizationId: org, membershipId: l2!.membershipId,
    roles: ["l2"], membershipRecordVersion: 1, roleBindingRecordVersions: [1],
    trialPrincipal: { userId: l2!.userId, organizationId: org, active: true,
      level: "l2", categories: ["international_school"], recordVersion: 1 },
  });
  const actor = (id: string, role: string) => ({ organizationId: org, actorUserId: id, actorRole: role });
  const forbidden = (error: unknown) => error instanceof CaseWorkspaceRepositoryError && error.code === "CASE_WORKSPACE_FORBIDDEN";
  try {
    await client.connect();
    await client.query("BEGIN");
    await context(founder!.userId);
    // Keep the legacy primary Advisor unconverted: conversion must not be required for read tests.
    for (const [person, level, categories] of [
      [founder!, "founder", []], [l1!, "l1", []],
      [l2!, "l2", ["international_school"]], [l3!, "l3", []],
    ] as const) {
      await client.query(`INSERT INTO access_trial_members
        (membership_id,organization_id,user_id,level,categories,created_by_user_id,updated_by_user_id)
        VALUES ($1,$2,$3,$4,$5,$6,$6)`, [person.membershipId,org,person.userId,level,categories,founder!.userId]);
      if (level !== "founder") {
        await client.query("UPDATE access_role_bindings SET status='revoked',record_version=record_version+1 WHERE id=$1", [person.roleBindingId]);
        await client.query(`INSERT INTO access_role_bindings
          (id,organization_id,membership_id,user_id,role,status,created_by_user_id)
          VALUES (gen_random_uuid(),$1,$2,$3,$4,'active',$5)`, [org,person.membershipId,person.userId,level,founder!.userId]);
      }
    }
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    for (const category of ["international_school", "local_school", null]) {
      await context(founder!.userId);
      await client.query("SAVEPOINT category_fixture");
      const caseId = randomUUID();
      await client.query(`INSERT INTO cases_service_cases
        (id,organization_id,student_id,case_number,application_type,intake_year,admission_type,
         primary_role_binding_id,primary_membership_id,primary_user_id,primary_role,stage,
         workflow_status,record_version,current_primary_advisor_assignment_id,business_category)
        VALUES ($1,$2,$3,$4,'k12',2090,'transfer',$5,$6,$7,'advisor','signed',
          'active',1,gen_random_uuid(),$8)`, [caseId,org,NEON_TEST_STUDENTS[0]!.id,
        `TRIAL-${caseId}`,advisor!.roleBindingId,advisor!.membershipId,advisor!.userId,category]);
      await client.query(`INSERT INTO cases_primary_advisor_assignments
        (id,organization_id,service_case_id,advisor_role_binding_id,membership_id,
         advisor_user_id,advisor_role,starts_at,assignment_reason)
        SELECT current_primary_advisor_assignment_id,organization_id,id,primary_role_binding_id,
          primary_membership_id,primary_user_id,'advisor',created_at,'trial_read_fixture'
        FROM cases_service_cases WHERE id=$1`, [caseId]);
      await client.query(`INSERT INTO cases_assessments
        (id,organization_id,service_case_id,manifest_id,status,record_version)
        VALUES (gen_random_uuid(),$1,$2,$3,'draft',1)`, [org,caseId,NEON_TEST_MANIFEST_ID]);
      await context(advisor!.userId);
      const advanced = await client.query("SELECT * FROM cases_advance_new_service_case($1,'advisor',$2,transaction_timestamp())", [caseId,randomUUID()]);
      assert.equal(advanced.rows[0]?.decision, "allowed");
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      await client.query("SET CONSTRAINTS ALL DEFERRED");
      for (const [person, level, visible] of [
        [founder!, "founder", category !== null], [l1!, "l1", category !== null],
        [l2!, "l2", category === "international_school"], [advisor!, "advisor", true],
      ] as const) {
        const input = actor(person.userId, level);
        const list = await repository.listCases(input);
        assert.equal(list.some((row) => row.id === caseId), visible, `${level} list ${category}`);
        assert.equal((await repository.findCase({ ...input,caseId }))?.id === caseId, visible, `${level} detail ${category}`);
      }
      await assert.rejects(repository.listCases(actor(l3!.userId, "l3")), forbidden);
      await assert.rejects(repository.findCase({ ...actor(l3!.userId, "l3"),caseId }), forbidden);
      await assert.rejects(repository.listCases(actor(l2!.userId, "founder")), forbidden);
      await context(founder!.userId);
      await client.query("UPDATE access_trial_members SET categories='{}',record_version=record_version+1 WHERE user_id=$1", [l2!.userId]);
      assert.equal(await service.findCase(cachedL2,caseId), null, "category revocation applies despite cached request categories");
      await context(founder!.userId);
      await client.query("UPDATE access_trial_members SET status='disabled',record_version=record_version+1 WHERE user_id=$1", [l2!.userId]);
      await assert.rejects(repository.listCases(actor(l2!.userId, "l2")), forbidden);
      await assert.rejects(service.listCases(cachedL2), (error: unknown) =>
        error instanceof CaseWorkspaceError && error.code === "CASE_WORKSPACE_FORBIDDEN");
      await assert.rejects(service.findCase(cachedL2,caseId), (error: unknown) =>
        error instanceof CaseWorkspaceError && error.code === "CASE_WORKSPACE_FORBIDDEN");
      await client.query("ROLLBACK TO SAVEPOINT category_fixture");
      await client.query("RELEASE SAVEPOINT category_fixture");
    }
    process.stdout.write(JSON.stringify({ trial_case_reads: "pass", scope: "SQL filtered", unknown_category: "denied", stale_role: "denied", revocation: "immediate", legacy: "preserved" }) + "\n");
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    await client.end();
  }
}
