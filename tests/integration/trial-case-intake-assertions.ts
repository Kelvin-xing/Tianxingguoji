import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { buildAccessContext, type TrialLevel, type K12BusinessCategory } from "../../modules/access/public.ts";
import { PostgresqlAccessCaseIntakeOwner } from "../../modules/access/infrastructure/postgresql-case-intake-owner.ts";
import { PostgresqlCrmCaseIntakeOwner } from "../../modules/crm/infrastructure/postgresql-case-intake-owner.ts";
import { CaseIntakeService, CaseIntakeOptionsCoordinator, CaseIntakeError } from "../../modules/cases/application/intake-service.ts";
import { PostgresqlCaseIntakeRepository } from "../../modules/cases/infrastructure/postgresql-case-intake-repository.ts";
import type { TenantTransactionRunner } from "../../modules/shared/server.ts";
import { assertTrialAssessments } from "./trial-assessment-assertions.ts";
import { assertTrialCandidates } from "./trial-candidate-assertions.ts";
import { assertTrialTasks } from "./trial-task-assertions.ts";
import { NEON_TEST_ORGANIZATION, NEON_TEST_PRINCIPALS, NEON_TEST_STUDENTS } from "../../scripts/db/neon-test-synthetic-fixture.ts";

export async function assertTrialCaseIntake(client: Client): Promise<void> {
  const org = NEON_TEST_ORGANIZATION.id;
  const [founder,l1,,l2,l3] = NEON_TEST_PRINCIPALS;
  let pending: Promise<unknown> = Promise.resolve();
  const runner: TenantTransactionRunner = {
    run(context, work) {
      const job = pending.then(async () => {
        await client.query("SAVEPOINT intake_command");
        try {
          await client.query("SELECT set_config('app.organization_id',$1,true),set_config('app.actor_user_id',$2,true)", [org,context.actorUserId]);
          const result = await work({ async query(query) {
            const result = await client.query(query.text, query.values ? [...query.values] : undefined);
            return { rows: result.rows, rowCount: result.rowCount };
          } });
          await client.query("SET CONSTRAINTS ALL IMMEDIATE");
          await client.query("SET CONSTRAINTS ALL DEFERRED");
          await client.query("RELEASE SAVEPOINT intake_command");
          return result;
        } catch (error) {
          await client.query("ROLLBACK TO SAVEPOINT intake_command");
          await client.query("RELEASE SAVEPOINT intake_command");
          throw error;
        }
      });
      pending = job.catch(() => {});
      return job;
    },
  };
  const crm = new PostgresqlCrmCaseIntakeOwner(runner);
  const access = new PostgresqlAccessCaseIntakeOwner(runner);
  const repository = new PostgresqlCaseIntakeRepository(runner,crm,access);
  const service = new CaseIntakeService(repository, new CaseIntakeOptionsCoordinator(crm,access));
  const actor = (person: typeof founder, level: TrialLevel, categories: readonly K12BusinessCategory[] = []) => buildAccessContext({
    organizationId: org, userId: person!.userId, membershipId: person!.membershipId,
    roles: [level], membershipRecordVersion: 1, roleBindingRecordVersions: [1],
    trialPrincipal: { organizationId: org, userId: person!.userId, level, categories, active: true, recordVersion: 1 },
  });
  const binding = async (user: string) => (await client.query("SELECT id FROM access_role_bindings WHERE user_id=$1 AND status='active'",[user])).rows[0]!.id as string;
  const command = async (person: typeof founder, category: K12BusinessCategory, year: number, student = NEON_TEST_STUDENTS[1]!.id) => ({
    studentId: student, primaryAdvisorRoleBindingId: await binding(person!.userId), businessCategory: category,
    referralSourceId: null, intakeYear: year, admissionType: "entry" as const,
    signedAt: new Date(Date.now()-60_000).toISOString(), requestId: randomUUID(), idempotencyKey: randomUUID(),
  });
  const rejected = (code: string) => (error: unknown) => error instanceof CaseIntakeError && error.code === code;
  await client.query("SAVEPOINT trial_intake_fixture");
  try {
    const initial = { actor: actor(founder,"founder"), command: await command(founder,"international_school",2091) };
    const before = Number((await client.query("SELECT count(*) AS n FROM audit_events WHERE event_type='cases.service_case_created'")).rows[0]!.n);
    const first = await service.createCase(initial);
    assert.equal(first.stage,"background_collection");
    assert.deepEqual(await service.createCase(initial),first,"replay returns identical receipt");
    assert.equal(Number((await client.query("SELECT count(*) AS n FROM audit_events WHERE event_type='cases.service_case_created'")).rows[0]!.n)-before,1);
    await assert.rejects(service.createCase({ ...initial,command: { ...initial.command,businessCategory: "local_school" } }),rejected("CASE_INTAKE_IDEMPOTENCY_CONFLICT"));
    const second = await service.createCase({ actor: actor(l1,"l1"), command: await command(l1,"local_school",2091,NEON_TEST_STUDENTS[0]!.id) });
    assert.equal(second.recordVersion,2);
    const restricted = actor(l2,"l2",["international_school"]);
    const options = await service.listIntakeOptions(restricted,{ businessCategory:"international_school" });
    assert.ok(options.students.some((s) => s.id === NEON_TEST_STUDENTS[1]!.id));
    assert.ok(!options.students.some((s) => s.id === NEON_TEST_STUDENTS[0]!.id));
    assert.ok(options.advisors.some((a) => a.role === "l2"));
    const thirdInput = { actor:restricted, command:await command(l2,"international_school",2092) };
    const third = await service.createCase(thirdInput);
    assert.equal(third.recordVersion,2);
    await assertTrialAssessments(client,runner,first.caseId,second.caseId);
    await assertTrialCandidates(client,runner,first.caseId,second.caseId);
    await assertTrialTasks(client,runner,first.caseId,second.caseId);
    await assert.rejects(service.createCase({ actor:restricted, command:await command(l2,"international_school",2093,NEON_TEST_STUDENTS[0]!.id) }),rejected("CASE_INTAKE_STUDENT_NOT_FOUND"));
    await assert.rejects(service.createCase({ actor:actor(l2,"l2",["local_school"]), command:await command(l2,"local_school",2093) }),rejected("CASE_INTAKE_FORBIDDEN"));
    await assert.rejects(service.createCase({ actor:actor(l3,"l3"), command:await command(l3,"international_school",2093) }),rejected("CASE_INTAKE_FORBIDDEN"));
    await assert.rejects(service.createCase({ actor:actor(founder,"founder"), command:{ ...await command(founder,"local_school",2093),primaryAdvisorRoleBindingId:await binding(l2!.userId) } }),rejected("CASE_INTAKE_ADVISOR_NOT_FOUND"));
    const existingAuditId = (await client.query("SELECT id FROM audit_events WHERE resource_id=$1 AND event_type='cases.service_case_created'",[first.caseId])).rows[0]!.id as string;
    const failing = new CaseIntakeService({ createCase(input) {
      return repository.createCase({ ...input,effects: {
        audit:{ ...input.effects.audit,id:existingAuditId },
        outbox:{ ...input.effects.outbox,auditEventId:existingAuditId },
      } });
    } },new CaseIntakeOptionsCoordinator(crm,access));
    await assert.rejects(failing.createCase({ actor:actor(founder,"founder"),command:await command(founder,"international_school",2094) }),rejected("CASE_INTAKE_UNAVAILABLE"));
    assert.equal((await client.query("SELECT count(*)::int AS n FROM cases_service_cases WHERE intake_year=2094")).rows[0]!.n,0,"audit failure rolls back the aggregate");
    await client.query("SELECT set_config('app.actor_user_id',$1,true)",[founder!.userId]);
    await client.query("UPDATE access_trial_members SET categories='{}',record_version=record_version+1 WHERE user_id=$1",[l2!.userId]);
    await assert.rejects(service.createCase({ actor:restricted, command:await command(l2,"international_school",2093) }),rejected("CASE_INTAKE_FORBIDDEN"));
    await assert.rejects(service.createCase(thirdInput),rejected("CASE_INTAKE_FORBIDDEN"));
    const persisted = await client.query("SELECT business_category,primary_role,stage FROM cases_service_cases WHERE id=ANY($1::uuid[]) ORDER BY primary_role",[[first.caseId,second.caseId,third.caseId]]);
    assert.deepEqual(persisted.rows.map((row) => row.primary_role),["founder","l1","l2"]);
    assert.ok(persisted.rows.every((row) => row.stage === "background_collection" && row.business_category !== null));
    process.stdout.write(JSON.stringify({ trial_case_intake:"pass", grades:"actual", idempotency:"single_audit", stale_scope:"denied", student_options:"scoped", owner_scope:"enforced" })+"\n");
  } finally {
    await pending;
    await client.query("ROLLBACK TO SAVEPOINT trial_intake_fixture");
    await client.query("RELEASE SAVEPOINT trial_intake_fixture");
  }
}
