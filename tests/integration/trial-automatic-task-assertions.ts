import { SchoolTargetService } from "../../modules/cases/application/school-target-service.ts";
import { PostgresqlSchoolTargetRepository } from "../../modules/cases/infrastructure/postgresql-school-target-repository.ts";
import { PostgresqlResolvedSchoolTransaction } from "../../modules/schools/server.ts";
import { InterviewTaskRequestConsumer } from "../../modules/tasks/application/interview-task-request-consumer.ts";
import { PostgresqlInterviewTaskRequestFacts } from "../../modules/cases/infrastructure/postgresql-interview-task-request-facts.ts";
import { InterviewInvitationService, InterviewInvitationError } from "../../modules/cases/application/interview-invitation-service.ts";
import { PostgresqlInterviewInvitationRepository } from "../../modules/cases/infrastructure/postgresql-interview-invitation-repository.ts";
import { assertTrialTaskDocuments } from "./trial-task-document-assertions.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { buildAccessContext, type TrialLevel } from "../../modules/access/public.ts";
import { PostgresqlAccessTaskFactsPort } from "../../modules/access/infrastructure/postgresql-task-authorization-facts.ts";
import { PostgresqlCasesTaskFactsPort } from "../../modules/cases/infrastructure/postgresql-task-provisioning-facts.ts";
import { PostgresqlCasesApplicationTaskRequestFactsPort } from "../../modules/cases/infrastructure/postgresql-application-task-request-facts.ts";
import { PostgresqlCleanTaskEvidencePort } from "../../modules/documents/infrastructure/postgresql-clean-task-evidence.ts";
import { ApplicationTaskRequestConsumer } from "../../modules/tasks/application/application-task-request-consumer.ts";
import { ApplicationSubmissionConsumer } from "../../modules/cases/application/application-submission-consumer.ts";
import { PostgresqlTasksApplicationCompletionEventFactsPort } from "../../modules/tasks/infrastructure/postgresql-application-completion-event-facts.ts";
import { P3TaskService,P3TaskError } from "../../modules/tasks/application/p3-service.ts";
import { PostgresqlP3TaskRepository } from "../../modules/tasks/infrastructure/p3-postgresql-repository.ts";
import { P3TaskReadService } from "../../modules/tasks/application/p3-read-service.ts";
import { PostgresqlP3TaskReadRepository } from "../../modules/tasks/infrastructure/postgresql-p3-read-repository.ts";
import { CaseWorkflowService } from "../../modules/cases/application/workflow-service.ts";
import { PostgresqlCaseWorkflowRepository } from "../../modules/cases/infrastructure/postgresql-workflow-repository.ts";
import { createPostgreSqlAdapter } from "../../modules/cases/infrastructure/postgresql.ts";
import { TaskWorkspaceService } from "../../modules/tasks/application/workspace-service.ts";
import { PostgresqlTaskWorkspaceRepository } from "../../modules/tasks/infrastructure/postgresql-workspace-repository.ts";
import type { TenantTransactionRunner } from "../../modules/shared/server.ts";
import { NEON_TEST_ORGANIZATION,NEON_TEST_PRINCIPALS } from "../../scripts/db/neon-test-synthetic-fixture.ts";

export async function assertTrialAutomaticTasks(client:Client,runner:TenantTransactionRunner,caseId:string,versionId:string):Promise<void> {
  const org=NEON_TEST_ORGANIZATION.id;
  const [founder,l1,,l2,l3]=NEON_TEST_PRINCIPALS;
  const actor=(person:typeof founder,level:TrialLevel)=>({ ...buildAccessContext({
    organizationId:org,userId:person!.userId,membershipId:person!.membershipId,roles:[level],membershipRecordVersion:1,roleBindingRecordVersions:[1],
    trialPrincipal:{ organizationId:org,userId:person!.userId,level,categories:level==="l2"?["international_school"]:[],active:true,recordVersion:1 },
  }),role:level,sessionId:randomUUID(),capturedSessionVersion:1,reauthenticatedAtMs:null });
  const root=actor(founder,"founder"),business=actor(l1,"l1"),restricted=actor(l2,"l2"),taskOnly=actor(l3,"l3");
  const consumer=new ApplicationTaskRequestConsumer(runner,new PostgresqlCasesApplicationTaskRequestFactsPort());
  const repository=new PostgresqlP3TaskRepository(runner,new PostgresqlCasesTaskFactsPort(),new PostgresqlAccessTaskFactsPort(),new PostgresqlCleanTaskEvidencePort());
  const service=new P3TaskService(repository);
  const workspace=new TaskWorkspaceService(new PostgresqlTaskWorkspaceRepository(runner));
  const reads=new P3TaskReadService(new PostgresqlP3TaskReadRepository(runner));
  const workflow=new CaseWorkflowService(new PostgresqlCaseWorkflowRepository(createPostgreSqlAdapter(runner)));
  const keys=()=>({ requestId:randomUUID(),idempotencyKey:randomUUID() });
  const rejected=(code:string)=>(error:unknown)=>error instanceof P3TaskError && error.code===code;
  await client.query("SAVEPOINT trial_automatic_tasks");
  try {
    const delivery={organizationId:org,caseId,versionId,requestId:randomUUID()};
    const failingConsumer=new ApplicationTaskRequestConsumer(runner,new PostgresqlCasesApplicationTaskRequestFactsPort(),undefined,{ failBeforeCommit(){throw new Error("Synthetic rollback");} });
    assert.equal((await failingConsumer.drainForCandidateVersion(delivery)).applicationTasks,"pending");
    assert.equal((await client.query("SELECT count(*)::int AS n FROM tasks_tasks WHERE service_case_id=$1 AND task_kind='application_prepare_submit'",[caseId])).rows[0]!.n,0);
    assert.deepEqual(await consumer.drainForCandidateVersion(delivery),{applicationTasks:"completed",requestedCount:1,provisionedCount:1});
    assert.deepEqual(await consumer.drainForCandidateVersion(delivery),{applicationTasks:"completed",requestedCount:1,provisionedCount:1});
    const tasks=await client.query("SELECT id,assignee_role FROM tasks_tasks WHERE service_case_id=$1 AND task_kind='application_prepare_submit'",[caseId]);
    assert.equal(tasks.rowCount,1); assert.equal(tasks.rows[0]!.assignee_role,"founder");
    const targets=new SchoolTargetService({repository:new PostgresqlSchoolTargetRepository(createPostgreSqlAdapter(runner),new PostgresqlResolvedSchoolTransaction())});
    assert.equal((await targets.getSchoolTargets({actor:business,caseId})).canRecordInterview,true);
    assert.equal((await targets.getSchoolTargets({actor:restricted,caseId})).items.length,1);
    await assert.rejects(targets.getSchoolTargets({actor:taskOnly,caseId}));
    const taskId=tasks.rows[0]!.id as string;
    assert.ok((await reads.readTask(business,taskId))!.allowed_actions.includes("reassign"));
    assert.equal(await reads.readTask(taskOnly,taskId),null);
    assert.equal((await reads.listAssigned(taskOnly)).length,0);
    const reassign={actor:business,taskId,action:"reassign" as const,expectedRecordVersion:1,nextAssigneeUserId:taskOnly.userId,reason:"Synthetic trial assignment",...keys()};
    await client.query("UPDATE tasks_tasks SET owner_user_id=$1 WHERE id=$2",[business.userId,taskId]);
    const assigned=await service.transitionTargetTask(reassign);
    assert.equal((await client.query("SELECT owner_user_id FROM tasks_tasks WHERE id=$1",[taskId])).rows[0]!.owner_user_id,root.userId);
    assert.equal(assigned.recordVersion,2); assert.equal(assigned.state,"assigned");
    assert.deepEqual(await service.transitionTargetTask(reassign),assigned);
    assert.equal((await reads.listAssigned(taskOnly)).length,1);
    assert.deepEqual((await reads.readTask(taskOnly,taskId))!.allowed_actions,["accept","reject"]);
    await client.query("SAVEPOINT paused_automatic_tasks");
    const caseVersion=Number((await client.query("SELECT record_version FROM cases_service_cases WHERE id=$1",[caseId])).rows[0]!.record_version);
    await workflow.applyWorkflowAction({actor:business,caseId,command:{action:"pause",expectedRecordVersion:caseVersion,reason:"Synthetic pause",...keys()}});
    assert.deepEqual((await reads.readTask(taskOnly,taskId))!.allowed_actions,[]);
    const paused=await workspace.detail(taskOnly,taskId);
    assert.deepEqual(paused!.task.allowedActions,[]); assert.deepEqual(paused!.task.availableTransitions,[]);
    await assert.rejects(service.transitionTargetTask({actor:taskOnly,taskId,action:"accept",expectedRecordVersion:2,...keys()}),rejected("NOT_FOUND"));
    await client.query("ROLLBACK TO SAVEPOINT paused_automatic_tasks");
    await client.query("RELEASE SAVEPOINT paused_automatic_tasks");
    await client.query("SAVEPOINT rejected_automatic_task");
    const reject={actor:taskOnly,taskId,action:"reject" as const,expectedRecordVersion:2,reason:"Synthetic rejection",...keys()};
    assert.equal((await service.transitionTargetTask(reject)).recordVersion,3);
    assert.equal(await reads.readTask(taskOnly,taskId),null);
    await assert.rejects(service.transitionTargetTask(reject),rejected("NOT_FOUND"));
    assert.equal((await service.transitionTargetTask({...reassign,actor:restricted,expectedRecordVersion:3,...keys()})).recordVersion,4);
    assert.equal((await service.transitionTargetTask({actor:business,taskId,action:"cancel",expectedRecordVersion:4,reason:"Synthetic cancel",...keys()})).recordVersion,5);
    assert.equal(await reads.readTask(taskOnly,taskId),null);
    await client.query("ROLLBACK TO SAVEPOINT rejected_automatic_task");
    await client.query("RELEASE SAVEPOINT rejected_automatic_task");
    const failing=new P3TaskService(new PostgresqlP3TaskRepository(runner,new PostgresqlCasesTaskFactsPort(),new PostgresqlAccessTaskFactsPort(),new PostgresqlCleanTaskEvidencePort(),{
      failBeforeCommit(){throw new Error("Synthetic task mutation rollback");}
    }));
    await assert.rejects(failing.transitionTargetTask({actor:taskOnly,taskId,action:"accept",expectedRecordVersion:2,...keys()}),rejected("UNAVAILABLE"));
    assert.equal((await reads.readTask(taskOnly,taskId))!.record_version,2);
    const accept={actor:taskOnly,taskId,action:"accept" as const,expectedRecordVersion:2,...keys()};
    assert.equal((await service.transitionTargetTask(accept)).recordVersion,3);
    const completion={submitted_at:"2026-09-18T00:00:00.000Z",submission_channel:"school_portal",submitter_user_id:taskOnly.userId,
      checklist_snapshot:{all_required_items_complete:true,confirmed_at:"2026-09-18T00:00:00.000Z"},official_submission_reference:"SYNTHETIC-REFERENCE",no_reference_declared:false};
    const complete={actor:taskOnly,taskId,action:"complete" as const,expectedRecordVersion:3,completionRecord:completion,...keys()};
    await assert.rejects(service.transitionTargetTask({...complete,completionRecord:{...completion,submitter_user_id:root.userId},...keys()}),rejected("COMPLETION_INVALID"));
    await assert.rejects(service.transitionTargetTask({...complete,completionRecord:{...completion,checklist_snapshot:{...completion.checklist_snapshot,all_required_items_complete:false}},...keys()}),rejected("COMPLETION_INVALID"));
    await assert.rejects(service.transitionTargetTask({...complete,completionRecord:{...completion,official_submission_reference:null,no_reference_declared:true},evidenceReference:randomUUID(),...keys()}),rejected("COMPLETION_INVALID"));
    const taskDocuments=await assertTrialTaskDocuments({client,runner,caseId,taskId,business,restricted,taskOnly});
    const withEvidence={...complete,completionRecord:{...completion,official_submission_reference:null,no_reference_declared:true},evidenceReference:taskDocuments.documentId};
    const completed=await service.transitionTargetTask(withEvidence);
    assert.equal(completed.state,"completed"); assert.equal(completed.recordVersion,4);
    assert.deepEqual(await service.transitionTargetTask(withEvidence),completed);
    assert.deepEqual(await service.transitionTargetTask(reassign),assigned);
    assert.deepEqual(await service.transitionTargetTask(accept),{...assigned,state:"accepted",recordVersion:3});
    await client.query("SAVEPOINT legacy_task_receipt");
    const legacyKey=randomUUID();
    await client.query(`INSERT INTO shared_idempotency_records(id,organization_id,actor_user_id,actor_kind,actor_opaque_id,operation,idempotency_key,request_hash,state)
      SELECT gen_random_uuid(),organization_id,actor_user_id,actor_kind,actor_opaque_id,operation,$1,request_hash,'in_progress'
      FROM shared_idempotency_records WHERE operation='tasks.school_target.transition' AND idempotency_key=$2`,[legacyKey,accept.idempotencyKey]);
    await client.query(`UPDATE shared_idempotency_records SET state='completed',result_reference=$1,
      response_hash=(SELECT response_hash FROM shared_idempotency_records WHERE operation='tasks.school_target.transition' AND idempotency_key=$2),
      record_version=record_version+1 WHERE idempotency_key=$3`,[taskId,accept.idempotencyKey,legacyKey]);
    assert.deepEqual(await service.transitionTargetTask({...accept,idempotencyKey:legacyKey}),{...assigned,state:"accepted",recordVersion:3});
    await client.query("ROLLBACK TO SAVEPOINT legacy_task_receipt");await client.query("RELEASE SAVEPOINT legacy_task_receipt");
    assert.deepEqual((await taskDocuments.links.list(taskOnly,taskId)).links[0]!.allowedActions,["document.read","document.download"]);
    assert.deepEqual((await reads.readTask(taskOnly,taskId))!.allowed_actions,[]);
    const revoke={actor:restricted,taskId,command:{assignmentId:(await workspace.detail(taskOnly,taskId))!.task.currentAssignment!.id,
      expectedRecordVersion:4,reason:"Synthetic completed assignment revoke",...keys()}};
    await client.query("SAVEPOINT paused_revocation");
    const latestCaseVersion=Number((await client.query("SELECT record_version FROM cases_service_cases WHERE id=$1",[caseId])).rows[0]!.record_version);
    await workflow.applyWorkflowAction({actor:business,caseId,command:{action:"pause",expectedRecordVersion:latestCaseVersion,reason:"Synthetic completed task pause",...keys()}});
    assert.deepEqual((await reads.readTask(restricted,taskId))!.allowed_actions,["revoke_access"]);
    const revoked=await workspace.revokeCompletedAssignment(revoke);
    assert.equal(revoked.recordVersion,5);
    assert.deepEqual(await workspace.revokeCompletedAssignment(revoke),revoked);
    assert.equal((await workspace.detail(business,taskId))!.task.state,"completed");
    assert.equal((await client.query("SELECT last_transition_receipt_id FROM tasks_tasks WHERE id=$1",[taskId])).rows[0]!.last_transition_receipt_id,completed.completionReceiptId);
    await assert.rejects(service.transitionTargetTask(complete),rejected("NOT_FOUND"));
    await assert.rejects(service.transitionTargetTask(accept),rejected("NOT_FOUND"));
    assert.equal(await workspace.detail(taskOnly,taskId),null);
    assert.equal(await reads.readTask(taskOnly,taskId),null);
    await client.query("ROLLBACK TO SAVEPOINT paused_revocation");
    await client.query("RELEASE SAVEPOINT paused_revocation");
    const submissions=new ApplicationSubmissionConsumer(runner,new PostgresqlTasksApplicationCompletionEventFactsPort(),new PostgresqlCleanTaskEvidencePort());
    const deliveryResult=await submissions.drainForTask({organizationId:org,taskId,requestId:randomUUID()});
    assert.equal(deliveryResult.targetTransition,"completed");
    assert.deepEqual(await submissions.drainForTask({organizationId:org,taskId,requestId:randomUUID()}),deliveryResult);
    assert.equal((await client.query("SELECT state FROM cases_school_targets WHERE id=$1",[deliveryResult.targetId])).rows[0]!.state,"submitted");
    await client.query("SAVEPOINT interview_provisioning");
    const targetForInterview=(await client.query("SELECT current_assignment_id,record_version FROM cases_school_targets WHERE id=$1",[deliveryResult.targetId])).rows[0]!;
    const provision={actor:business,caseId,targetId:deliveryResult.targetId,assignmentId:targetForInterview.current_assignment_id as string,
      sourceEventId:randomUUID(),kind:"interview_support" as const,taskKey:`interview-${randomUUID()}`,
      dueAt:"2026-09-25T02:00:00.000Z",title:"Synthetic interview support",brief:"Synthetic necessary background",...keys()};
    await assert.rejects(service.ensureTargetTask(provision),rejected("CONFLICT"));
    const invitations=new InterviewInvitationService(new PostgresqlInterviewInvitationRepository(runner,new PostgresqlCleanTaskEvidencePort()));
    const invitation={actor:restricted,caseId,targetId:deliveryResult.targetId,expectedRecordVersion:Number(targetForInterview.record_version),
      interviewAt:"2026-09-25T02:00:00Z",invitationDocumentId:taskDocuments.documentId,...keys()};
    await assert.rejects(invitations.record({...invitation,invitationDocumentId:randomUUID(),...keys()}),error=>error instanceof InterviewInvitationError&&error.code==="EVIDENCE_REQUIRED");
    await assert.rejects(invitations.record({...invitation,actor:taskOnly,...keys()}));
    const failingInvitations=new InterviewInvitationService(new PostgresqlInterviewInvitationRepository(runner,new PostgresqlCleanTaskEvidencePort(),{failBeforeCommit(){throw new Error("Synthetic rollback");}}));
    await assert.rejects(failingInvitations.record(invitation),error=>error instanceof InterviewInvitationError&&error.code==="UNAVAILABLE");
    assert.equal((await client.query("SELECT state FROM cases_school_targets WHERE id=$1",[deliveryResult.targetId])).rows[0]!.state,"submitted");
    const recordedInvitation=await invitations.record(invitation);
    assert.deepEqual(await invitations.record(invitation),recordedInvitation);
    assert.equal((await client.query("SELECT count(*)::int AS n FROM audit_events WHERE resource_id=$1 AND event_type='cases.interview_invitation_recorded'",[deliveryResult.targetId])).rows[0]!.n,1);
    await client.query("SAVEPOINT invitation_revocation");
    await client.query("SELECT set_config('app.actor_user_id',$1,true)",[root.userId]);
    await client.query("UPDATE access_trial_members SET categories='{}',record_version=record_version+1 WHERE user_id=$1",[restricted.userId]);
    await assert.rejects(targets.getSchoolTargets({actor:restricted,caseId}));
    await assert.rejects(invitations.record({...invitation,actor:restricted}),error=>error instanceof InterviewInvitationError&&error.code==="NOT_FOUND");
    await client.query("ROLLBACK TO SAVEPOINT invitation_revocation");await client.query("RELEASE SAVEPOINT invitation_revocation");
    await client.query("SAVEPOINT automatic_interview_delivery");
    const interviewDelivery={organizationId:org,caseId,targetId:deliveryResult.targetId,invitationId:recordedInvitation.invitationId,requestId:randomUUID()};
    const interviewConsumer=new InterviewTaskRequestConsumer(runner,new PostgresqlInterviewTaskRequestFacts());
    const brokenInterviewConsumer=new InterviewTaskRequestConsumer(runner,new PostgresqlInterviewTaskRequestFacts(),undefined,{failBeforeCommit(){throw new Error("Synthetic rollback");}});
    assert.equal(await brokenInterviewConsumer.drainForInvitation(interviewDelivery),false);
    assert.equal((await client.query("SELECT count(*)::int AS n FROM tasks_tasks WHERE school_target_id=$1 AND task_kind='interview_support'",[deliveryResult.targetId])).rows[0]!.n,0);
    assert.equal(await interviewConsumer.drainForInvitation(interviewDelivery),true);
    assert.equal(await interviewConsumer.drainForInvitation(interviewDelivery),true);
    assert.equal(await interviewConsumer.drainForInvitation({...interviewDelivery,caseId:randomUUID()}),false);
    const automaticallyCreated=(await client.query("SELECT assignee_user_id,assignee_role FROM tasks_tasks WHERE school_target_id=$1 AND task_kind='interview_support'",[deliveryResult.targetId])).rows;
    assert.equal(automaticallyCreated.length,1);assert.equal(automaticallyCreated[0]!.assignee_user_id,root.userId);
    assert.equal(automaticallyCreated[0]!.assignee_role,"founder");
    await client.query("ROLLBACK TO SAVEPOINT automatic_interview_delivery");await client.query("RELEASE SAVEPOINT automatic_interview_delivery");
    await assert.rejects(failing.ensureTargetTask(provision),rejected("UNAVAILABLE"));
    assert.equal((await client.query("SELECT count(*)::int AS n FROM tasks_tasks WHERE task_key=$1",[provision.taskKey])).rows[0]!.n,0);
    const interview=await service.ensureTargetTask(provision);
    assert.equal(interview.state,"assigned");
    assert.deepEqual(await service.ensureTargetTask(provision),interview);
    const interviewAssignment=(await client.query("SELECT id FROM tasks_task_assignments WHERE task_id=$1",[interview.id])).rows[0]!.id;
    assert.notEqual(interviewAssignment,targetForInterview.current_assignment_id);
    assert.equal((await client.query("SELECT count(*)::int AS n FROM tasks_tasks WHERE task_key=$1",[provision.taskKey])).rows[0]!.n,1);
    assert.equal((await service.transitionTargetTask({actor:business,taskId:interview.id,action:"reassign",expectedRecordVersion:1,
      nextAssigneeUserId:taskOnly.userId,reason:"Synthetic interview assignment",...keys()})).recordVersion,2);
    assert.equal((await service.transitionTargetTask({actor:taskOnly,taskId:interview.id,action:"accept",expectedRecordVersion:2,...keys()})).recordVersion,3);
    const interviewCompleted=await service.transitionTargetTask({actor:taskOnly,taskId:interview.id,action:"complete",expectedRecordVersion:3,
      completionRecord:{completed_at:"2026-09-18T02:00:00Z",interview_method:"Video",coaching_summary:"Synthetic preparation"},...keys()});
    assert.equal(interviewCompleted.state,"completed");
    assert.equal((await client.query("SELECT state FROM cases_school_targets WHERE id=$1",[deliveryResult.targetId])).rows[0]!.state,"interview");
    // Another explicit school event may provision another task without reusing its assignment key.
    const subsequent=await service.ensureTargetTask({...provision,sourceEventId:randomUUID(),taskKey:`interview-${randomUUID()}`,...keys()});
    assert.notEqual(subsequent.id,interview.id);
    await client.query("ROLLBACK TO SAVEPOINT interview_provisioning");await client.query("RELEASE SAVEPOINT interview_provisioning");
    const detail=await workspace.detail(taskOnly,taskId);
    assert.equal(detail!.audience,"assigned_task"); assert.equal(detail!.task.state,"completed");
    assert.deepEqual(detail!.task.allowedActions,[]); assert.equal("caseId" in detail!.task,false);
    await client.query("SAVEPOINT revoked_automatic_scope");
    await client.query("SELECT set_config('app.actor_user_id',$1,true)",[root.userId]);
    await client.query("UPDATE access_trial_members SET categories='{}',record_version=record_version+1 WHERE user_id=$1",[restricted.userId]);
    await assert.rejects(service.transitionTargetTask({...reassign,actor:restricted,...keys()}),rejected("NOT_FOUND"));
    await client.query("ROLLBACK TO SAVEPOINT revoked_automatic_scope");
    await client.query("RELEASE SAVEPOINT revoked_automatic_scope");
    const revokedFinal=await workspace.revokeCompletedAssignment(revoke);
    assert.equal(revokedFinal.recordVersion,5);
    await assert.rejects(taskDocuments.links.list(taskOnly,taskId));
    assert.deepEqual(await workspace.revokeCompletedAssignment(revoke),revokedFinal);
    assert.equal((await workspace.detail(business,taskId))!.task.state,"completed");
    assert.equal((await client.query("SELECT last_transition_receipt_id FROM tasks_tasks WHERE id=$1",[taskId])).rows[0]!.last_transition_receipt_id,completed.completionReceiptId);
    await assert.rejects(service.transitionTargetTask(complete),rejected("NOT_FOUND"));
    await assert.rejects(service.transitionTargetTask(accept),rejected("NOT_FOUND"));
    assert.equal(await workspace.detail(taskOnly,taskId),null);
    assert.equal(await reads.readTask(taskOnly,taskId),null);
    assert.equal((await client.query("SELECT state FROM cases_school_targets WHERE id=$1",[deliveryResult.targetId])).rows[0]!.state,"submitted");
    process.stdout.write(JSON.stringify({trial_automatic_tasks:"pass",consumer:"single_delivery_actual_role",l1:"reassign_l3",completion:"receipt_conditions_enforced",l3_completed:"readonly",revoked_replay:"denied"})+"\n");
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT trial_automatic_tasks");
    await client.query("RELEASE SAVEPOINT trial_automatic_tasks");
  }
}
