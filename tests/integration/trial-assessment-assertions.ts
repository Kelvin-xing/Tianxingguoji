import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { buildAccessContext, type TrialLevel } from "../../modules/access/public.ts";
import { AssessmentService, AssessmentServiceError, type AssessmentRepository } from "../../modules/cases/application/assessment-service.ts";
import { PostgresqlAssessmentRepository } from "../../modules/cases/infrastructure/postgresql-assessment-repository.ts";
import { createPostgreSqlAdapter } from "../../modules/cases/infrastructure/postgresql.ts";
import { CaseWorkflowService, CaseWorkflowError } from "../../modules/cases/application/workflow-service.ts";
import { PostgresqlCaseWorkflowRepository } from "../../modules/cases/infrastructure/postgresql-workflow-repository.ts";
import type { TenantTransactionRunner } from "../../modules/shared/server.ts";
import { NEON_TEST_ORGANIZATION, NEON_TEST_PRINCIPALS } from "../../scripts/db/neon-test-synthetic-fixture.ts";

export async function assertTrialAssessments(client: Client, runner: TenantTransactionRunner, internationalCaseId: string, localCaseId: string): Promise<void> {
  const org = NEON_TEST_ORGANIZATION.id;
  const [founder,l1,,l2,l3] = NEON_TEST_PRINCIPALS;
  const actor = (person: typeof founder, level: TrialLevel) => ({ ...buildAccessContext({
    organizationId: org, userId: person!.userId, membershipId: person!.membershipId,
    roles: [level], membershipRecordVersion: 1, roleBindingRecordVersions: [1],
    trialPrincipal: { organizationId: org, userId: person!.userId, level,
      categories: level === "l2" ? ["international_school"] : [], active: true, recordVersion: 1 },
  }),role:level,sessionId:randomUUID(),capturedSessionVersion:1,reauthenticatedAtMs:null });
  const repository = new PostgresqlAssessmentRepository(createPostgreSqlAdapter(runner));
  const service = new AssessmentService({ repository });
  const workflow = new CaseWorkflowService(new PostgresqlCaseWorkflowRepository(createPostgreSqlAdapter(runner)));
  const root = actor(founder,"founder"), business = actor(l1,"l1"), restricted = actor(l2,"l2"), taskOnly = actor(l3,"l3");
  const command = (expectedRecordVersion = 0) => ({
    fieldId: "student_profile.date_of_birth", semanticState: "provided" as const,
    value: { type: "date", value: "2014-03-12" }, valueType: "date",
    expectedRecordVersion, requestId: randomUUID(), idempotencyKey: randomUUID(),
  });
  const rejected = (code: string) => (error: unknown) => error instanceof AssessmentServiceError && error.code === code;
  await client.query("SAVEPOINT trial_assessment_fixture");
  try {
    for (const member of [root,business]) for (const caseId of [internationalCaseId,localCaseId]) {
      const view = await service.getCaseAssessment({ actor: member,caseId });
      assert.equal(view.access.mode,"full");
      assert.equal(view.access.canEdit,true);
    }
    assert.equal((await service.getCaseAssessment({ actor:restricted,caseId:internationalCaseId })).access.canEdit,true);
    await assert.rejects(service.getCaseAssessment({ actor:restricted,caseId:localCaseId }),rejected("ASSESSMENT_CASE_NOT_FOUND"));
    await assert.rejects(service.getCaseAssessment({ actor:taskOnly,caseId:internationalCaseId }),rejected("ASSESSMENT_READ_FORBIDDEN"));
    await assert.rejects(service.updateAssessmentAnswer({ actor:taskOnly,caseId:internationalCaseId,command:command() }),rejected("ASSESSMENT_WRITE_FORBIDDEN"));
    const firstInput = { actor:root,caseId:internationalCaseId,command:command() };
    const first = await service.updateAssessmentAnswer(firstInput);
    assert.equal(first.recordVersion,1);
    assert.deepEqual(await service.updateAssessmentAnswer(firstInput),first);
    await assert.rejects(service.updateAssessmentAnswer({ ...firstInput,command:command() }),rejected("ASSESSMENT_ANSWER_STALE_VERSION"));
    assert.equal((await service.updateAssessmentAnswer({ actor:business,caseId:localCaseId,command:command() })).recordVersion,1);
    const restrictedInput = { actor:restricted,caseId:internationalCaseId,command:command(1) };
    assert.equal((await service.updateAssessmentAnswer(restrictedInput)).recordVersion,2);
    await assert.rejects(service.updateAssessmentAnswer({ actor:restricted,caseId:localCaseId,command:command(1) }),rejected("ASSESSMENT_CASE_NOT_FOUND"));
    const auditId = (await client.query("SELECT id FROM audit_events WHERE event_type='cases.assessment_answer_updated' ORDER BY occurred_at LIMIT 1")).rows[0]!.id as string;
    const failingRepository: AssessmentRepository = {
      readCaseAssessment: repository.readCaseAssessment.bind(repository),
      completeBackgroundCollection: repository.completeBackgroundCollection.bind(repository),
      updateAssessmentAnswer(input) { return repository.updateAssessmentAnswer({ ...input,effects: {
        audit: { ...input.effects.audit,id:auditId }, outbox:{ ...input.effects.outbox,auditEventId:auditId },
      } }); },
    };
    await assert.rejects(new AssessmentService({ repository:failingRepository }).updateAssessmentAnswer({ actor:root,caseId:internationalCaseId,command:command(2) }));
    const answers = (await service.getCaseAssessment({ actor:root,caseId:internationalCaseId })).answers;
    assert.equal(answers.find((answer) => answer.fieldId === firstInput.command.fieldId)!.recordVersion,2,"audit failure rolls back answer revision");
    const count = await client.query("SELECT count(*)::int AS n FROM audit_events WHERE event_type='cases.assessment_answer_updated' AND request_id=$1",[firstInput.command.requestId]);
    assert.equal(count.rows[0]!.n,1,"replay produces one audit event");
    const pause = { actor:restricted,caseId:internationalCaseId,command: {
      action:"pause" as const,expectedRecordVersion:2,reason:"Synthetic scope test",requestId:randomUUID(),idempotencyKey:randomUUID(),
    } };
    assert.equal((await workflow.applyWorkflowAction(pause)).recordVersion,3);
    assert.equal((await workflow.applyWorkflowAction(pause)).recordVersion,3);
    assert.equal((await service.getCaseAssessment({ actor:business,caseId:internationalCaseId })).access.canEdit,false,"paused case remains readable but not editable");
    await assert.rejects(service.updateAssessmentAnswer({ actor:root,caseId:internationalCaseId,command:command(2) }),rejected("ASSESSMENT_CASE_NOT_FOUND"));
    await assert.rejects(workflow.applyWorkflowAction({ ...pause,actor:taskOnly }), (error:unknown) => error instanceof CaseWorkflowError && error.code === "CASE_WORKFLOW_FORBIDDEN");
    await assert.rejects(workflow.applyWorkflowAction({ ...pause,caseId:localCaseId,command:{ ...pause.command,idempotencyKey:randomUUID() } }), (error:unknown) => error instanceof CaseWorkflowError && error.code === "CASE_WORKFLOW_CASE_NOT_FOUND");
    const resume = { ...pause,actor:business,command: { ...pause.command,action:"resume" as const,reason:null,expectedRecordVersion:3,idempotencyKey:randomUUID() } };
    assert.equal((await workflow.applyWorkflowAction(resume)).recordVersion,4);
    assert.equal((await service.getCaseAssessment({ actor:business,caseId:internationalCaseId })).access.canEdit,true);
    await client.query("SELECT set_config('app.actor_user_id',$1,true)",[founder!.userId]);
    await client.query("UPDATE access_trial_members SET categories='{}',record_version=record_version+1 WHERE user_id=$1",[l2!.userId]);
    await assert.rejects(service.getCaseAssessment({ actor:restricted,caseId:internationalCaseId }),rejected("ASSESSMENT_CASE_NOT_FOUND"));
    await assert.rejects(service.updateAssessmentAnswer(restrictedInput),rejected("ASSESSMENT_CASE_NOT_FOUND"));
    await assert.rejects(workflow.applyWorkflowAction(pause), (error:unknown) => error instanceof CaseWorkflowError && error.code === "CASE_WORKFLOW_CASE_NOT_FOUND");
    process.stdout.write(JSON.stringify({ trial_assessments:"pass", category_scope:"enforced", l3:"denied", replay:"single_audit", audit_failure:"rolled_back", revocation:"immediate", workflow:"pause_resume_readonly_and_revoked_replay" })+"\n");
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT trial_assessment_fixture");
    await client.query("RELEASE SAVEPOINT trial_assessment_fixture");
  }
}
