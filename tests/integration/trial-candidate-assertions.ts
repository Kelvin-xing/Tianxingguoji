import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { buildAccessContext, type TrialLevel } from "../../modules/access/public.ts";
import { AssessmentService } from "../../modules/cases/application/assessment-service.ts";
import { CandidateListService, CandidateListError } from "../../modules/cases/application/candidate-list-service.ts";
import { CandidateListQueryService } from "../../modules/cases/application/candidate-list-query-service.ts";
import { PostgresqlAssessmentRepository } from "../../modules/cases/infrastructure/postgresql-assessment-repository.ts";
import { PostgresqlCandidateListRepository } from "../../modules/cases/infrastructure/postgresql-candidate-list-repository.ts";
import { PostgresqlCandidateListQueryRepository } from "../../modules/cases/infrastructure/postgresql-candidate-list-query-repository.ts";
import { createPostgreSqlAdapter } from "../../modules/cases/infrastructure/postgresql.ts";
import { SchoolOptionsService } from "../../modules/schools/application/school-options-service.ts";
import { PostgresqlSchoolOptionsRepository } from "../../modules/schools/infrastructure/postgresql-school-options-repository.ts";
import { GuardianConfirmationOptionsService } from "../../modules/crm/application/guardian-confirmation-options-service.ts";
import { PostgresqlGuardianConfirmationOptionsRepository } from "../../modules/crm/infrastructure/postgresql-guardian-confirmation-options-repository.ts";
import type { TenantTransactionRunner } from "../../modules/shared/server.ts";
import { NEON_TEST_ORGANIZATION, NEON_TEST_PRINCIPALS, NEON_TEST_STUDENTS } from "../../scripts/db/neon-test-synthetic-fixture.ts";

import { assertTrialAutomaticTasks } from "./trial-automatic-task-assertions.ts";

export async function assertTrialCandidates(client: Client, runner: TenantTransactionRunner, caseId: string, localCaseId: string): Promise<void> {
  const org = NEON_TEST_ORGANIZATION.id;
  const [founder,l1,,l2,l3] = NEON_TEST_PRINCIPALS;
  const actor = (person: typeof founder, level: TrialLevel) => buildAccessContext({
    organizationId:org,userId:person!.userId,membershipId:person!.membershipId,roles:[level],
    membershipRecordVersion:1,roleBindingRecordVersions:[1],trialPrincipal:{ organizationId:org,
      userId:person!.userId,level,categories:level === "l2" ? ["international_school"] : [],active:true,recordVersion:1 },
  });
  const root=actor(founder,"founder"), business=actor(l1,"l1"), restricted=actor(l2,"l2"), taskOnly=actor(l3,"l3");
  const assessments = new AssessmentService({ repository:new PostgresqlAssessmentRepository(createPostgreSqlAdapter(runner)) });
  const candidates = new CandidateListService(new PostgresqlCandidateListRepository(runner));
  const query = new CandidateListQueryService(new PostgresqlCandidateListQueryRepository(runner));
  const schools = new SchoolOptionsService(new PostgresqlSchoolOptionsRepository(runner));
  const guardians = new GuardianConfirmationOptionsService(new PostgresqlGuardianConfirmationOptionsRepository(runner));
  const keys = () => ({ requestId:randomUUID(),idempotencyKey:randomUUID() });
  const rejected = (code: string) => (error: unknown) => error instanceof CandidateListError && error.code === code;
  await client.query("SAVEPOINT trial_candidate_fixture");
  try {
    const view = await assessments.getCaseAssessment({ actor:restricted,caseId });
    for (const [index,field] of view.schema.fields.entries()) {
      const value = field.valueType === "date" ? "2014-03-12" : field.valueType === "integer" ? index+1
        : field.valueType === "enum" ? field.enumValues![0] : field.valueType === "enum_set" ? [field.enumValues![0]] : `Synthetic-${index}`;
      await assessments.updateAssessmentAnswer({ actor:restricted,caseId,command:{ ...keys(),fieldId:field.fieldId,
        semanticState:"provided",value:{ type:field.valueType,value },valueType:field.valueType,expectedRecordVersion:0 } });
    }
    await assessments.completeBackgroundCollection({ actor:restricted,caseId,command:{ ...keys(),expectedRecordVersion:1 } });
    const revisionId = randomUUID();
    const revision = await client.query(`INSERT INTO schools_resolved_revisions
      (id,organization_id,school_id,base_snapshot_id,overlay_revision_id,resolution_sha256,fields_json,provenance_json,conflicts_json)
      SELECT $1,organization_id,school_id,snapshot_id,NULL,record_sha256,fields_json,provenance_json,'[]'::jsonb
      FROM schools_snapshot_records ORDER BY id LIMIT 1 RETURNING school_id,resolution_sha256`,[revisionId]);
    assert.equal(revision.rowCount,1);
    assert.ok((await schools.list({ actor:restricted })).items.some((school) => school.schoolId === revision.rows[0]!.school_id));
    await assert.rejects(async () => schools.list({ actor:taskOnly }));
    assert.equal((await guardians.list({ actor:restricted,studentId:NEON_TEST_STUDENTS[1]!.id })).length,1);
    await assert.rejects(async () => guardians.list({ actor:restricted,studentId:NEON_TEST_STUDENTS[0]!.id }));
    const create = { actor:restricted,caseId,previousVersionId:null,expectedCaseRecordVersion:2,
      changeSummary:"Synthetic trial list",items:[{ schoolId:revision.rows[0]!.school_id,pinnedResolvedRevisionId:revisionId,
        pinnedResolutionSha256:revision.rows[0]!.resolution_sha256,ordinal:1,applicationDeadline:"2099-04-15T12:00:00.000Z" }],...keys() };
    await assert.rejects(async () => candidates.createVersion({ ...create,caseId:localCaseId,...keys() }),rejected("CANDIDATE_LIST_NOT_FOUND"));
    await assert.rejects(async () => candidates.createVersion({ ...create,actor:taskOnly,...keys() }),rejected("CANDIDATE_LIST_FORBIDDEN"));
    const submitted = await candidates.createVersion(create);
    assert.equal(submitted.recordVersion,2);
    assert.deepEqual(await candidates.createVersion(create),submitted);
    for (const member of [root,business,restricted]) {
      const lists = await query.list({ actor:member,caseId,requestId:randomUUID() });
      assert.equal(lists.items[0]!.id,submitted.id);
    }
    const review = { actor:business,caseId,versionId:submitted.id,expectedRecordVersion:2,decision:"approved" as const,reason:"Synthetic approval",...keys() };
    await assert.rejects(async () => candidates.reviewVersion({ ...review,actor:restricted,...keys() }),rejected("CANDIDATE_LIST_FORBIDDEN"));
    const approved = await candidates.reviewVersion(review);
    assert.equal(approved.recordVersion,3);
    assert.deepEqual(await candidates.reviewVersion(review),approved);
    const student = NEON_TEST_STUDENTS[1]!;
    const confirmation = { actor:restricted,caseId,versionId:submitted.id,expectedListRecordVersion:3,expectedCaseRecordVersion:2,
      guardianId:student.guardianId,guardianRelationshipId:student.relationshipId,decision:"confirmed" as const,
      channel:"phone" as const,guardianDecidedAt:new Date().toISOString(),boundFounderDecisionSha256:approved.founderDecisionSha256!,...keys() };
    const confirmed = await candidates.recordGuardianDecision(confirmation);
    assert.equal(confirmed.recordVersion,4);
    assert.deepEqual(await candidates.recordGuardianDecision(confirmation),confirmed);
    assert.equal((await client.query("SELECT count(*)::int AS n FROM audit_events WHERE event_type='cases.application_task_requested' AND resource_id IN (SELECT id FROM cases_school_targets WHERE service_case_id=$1)",[caseId])).rows[0]!.n,1,"confirmation replay emits one application request");
    assert.equal((await client.query("SELECT stage FROM cases_service_cases WHERE id=$1",[caseId])).rows[0]!.stage,"application_in_progress");
    assert.equal((await client.query("SELECT assignee_role FROM cases_school_target_assignments WHERE service_case_id=$1",[caseId])).rows[0]!.assignee_role,"founder");
    await assertTrialAutomaticTasks(client,runner,caseId,submitted.id);
    const close = { actor:business,caseId,expectedCaseRecordVersion:4,closureOutcome:"no_offer" as const,reason:"Synthetic close",...keys() };
    await assert.rejects(async () => candidates.closeCase({ ...close,actor:restricted }),rejected("CANDIDATE_LIST_FORBIDDEN"));
    await assert.rejects(candidates.closeCase(close),rejected("CASE_CLOSE_TARGETS_INCOMPLETE"));
    await client.query("SELECT set_config('app.actor_user_id',$1,true)",[founder!.userId]);
    await client.query("UPDATE access_trial_members SET categories='{}',record_version=record_version+1 WHERE user_id=$1",[l2!.userId]);
    await assert.rejects(candidates.createVersion(create),rejected("CANDIDATE_LIST_NOT_FOUND"));
    await assert.rejects(query.list({ actor:restricted,caseId,requestId:randomUUID() }));
    await assert.rejects(async () => guardians.list({ actor:restricted,studentId:NEON_TEST_STUDENTS[1]!.id }));
    process.stdout.write(JSON.stringify({ trial_candidates:"pass", submit:"l2_scoped", approval:"l1_only", guardian:"confirmed", closure:"business_constraints_preserved", replay:"revoked_scope_denied" })+"\n");
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT trial_candidate_fixture");
    await client.query("RELEASE SAVEPOINT trial_candidate_fixture");
  }
}
