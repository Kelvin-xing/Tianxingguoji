import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { buildAccessContext, type TrialLevel } from "../../modules/access/public.ts";
import { TaskWorkspaceService, TaskWorkspaceError } from "../../modules/tasks/application/workspace-service.ts";
import { PostgresqlTaskWorkspaceRepository } from "../../modules/tasks/infrastructure/postgresql-workspace-repository.ts";
import type { TenantTransactionRunner } from "../../modules/shared/server.ts";
import { NEON_TEST_ORGANIZATION, NEON_TEST_PRINCIPALS } from "../../scripts/db/neon-test-synthetic-fixture.ts";

export async function assertTrialTasks(client: Client, runner: TenantTransactionRunner, caseId: string, localCaseId: string): Promise<void> {
  const org=NEON_TEST_ORGANIZATION.id;
  const [founder,l1,,l2,l3]=NEON_TEST_PRINCIPALS;
  const actor=(person:typeof founder,level:TrialLevel) => ({ ...buildAccessContext({
    organizationId:org,userId:person!.userId,membershipId:person!.membershipId,roles:[level],
    membershipRecordVersion:1,roleBindingRecordVersions:[1],trialPrincipal:{ organizationId:org,
      userId:person!.userId,level,categories:level === "l2" ? ["international_school"] : [],active:true,recordVersion:1 },
  }),role:level,sessionId:randomUUID(),capturedSessionVersion:1,reauthenticatedAtMs:null });
  const root=actor(founder,"founder"), business=actor(l1,"l1"), restricted=actor(l2,"l2"), taskOnly=actor(l3,"l3");
  const service=new TaskWorkspaceService(new PostgresqlTaskWorkspaceRepository(runner));
  const keys=() => ({ requestId:randomUUID(),idempotencyKey:randomUUID() });
  const rejected=(code:string)=>(error:unknown)=>error instanceof TaskWorkspaceError && error.code===code;
  const command=(caseId:string) => ({ caseId,title:"Synthetic assigned task",taskBrief:"Only the current task instructions",
    dueAt:"2099-04-15T12:00:00.000Z",assigneeUserId:taskOnly.userId,...keys() });
  const transition=(taskId:string,to:"accepted"|"completed"|"awaiting_reassignment"|"assigned"|"cancelled",version:number,member=taskOnly) =>
    service.transition({ actor:member,taskId,command:{ to,expectedRecordVersion:version,reason:"Synthetic task operation",
      nextAssigneeUserId:to === "assigned" ? taskOnly.userId : null,...keys() } });
  await client.query("SAVEPOINT trial_task_fixture");
  try {
    assert.ok((await service.options(restricted,caseId))!.assignees.some((person)=>person.id===taskOnly.userId && person.role==="l3"));
    assert.equal(await service.options(restricted,localCaseId),null);
    const firstInput={ actor:restricted,command:command(caseId) };
    const first=await service.create(firstInput);
    assert.deepEqual(await service.create(firstInput),first);
    const second=await service.create({ actor:business,command:command(localCaseId) });
    await assert.rejects(async()=>service.create({ actor:restricted,command:command(localCaseId) }),rejected("TASK_NOT_FOUND"));
    await assert.rejects(async()=>service.create({ actor:taskOnly,command:command(caseId) }),rejected("TASK_FORBIDDEN"));
    await assert.rejects(async()=>service.create({ actor:root,command:{ ...command(caseId),assigneeUserId:business.userId } }),rejected("TASK_NOT_FOUND"));
    const listed=await service.list(taskOnly,null);
    assert.equal(listed.audience,"assigned_task");
    assert.ok(listed.tasks.some((task)=>task.id===first.id));
    assert.ok(listed.tasks.some((task)=>task.id===second.id));
    for (const task of listed.tasks) {
      assert.equal("caseId" in task,false); assert.equal("caseNumber" in task,false); assert.equal("assignee" in task,false);
    }
    await assert.rejects(async()=>service.list(taskOnly,caseId),rejected("TASK_FORBIDDEN"));
    assert.equal(await service.detail(restricted,second.id),null);
    assert.equal((await transition(first.id,"accepted",1)).recordVersion,2);
    assert.equal((await transition(first.id,"completed",2)).recordVersion,3);
    const completed=await service.detail(taskOnly,first.id);
    assert.equal(completed!.task.state,"completed");
    assert.deepEqual(completed!.task.availableTransitions,[]);
    assert.deepEqual(completed!.task.allowedActions,[]);
    await assert.rejects(transition(first.id,"accepted",3),rejected("TASK_CONFLICT"));
    await transition(second.id,"awaiting_reassignment",1);
    assert.equal(await service.detail(taskOnly,second.id),null,"reject immediately removes access");
    await transition(second.id,"assigned",2,business);
    assert.ok(await service.detail(taskOnly,second.id));
    await transition(second.id,"cancelled",3,business);
    assert.equal(await service.detail(taskOnly,second.id),null,"cancel removes access");
    const third=await service.create({ actor:restricted,command:command(caseId) });
    await transition(third.id,"accepted",1);
    await transition(third.id,"awaiting_reassignment",2,business);
    assert.equal(await service.detail(taskOnly,third.id),null,"manager revocation ends the current assignment");
    // A disabled recipient must not hide the task from its current manager.
    await client.query("SAVEPOINT disabled_recipient");
    await client.query("SELECT set_config('app.actor_user_id',$1,true)",[root.userId]);
    await client.query("UPDATE identity_users SET status='disabled',session_version=session_version+1 WHERE id=$1",[taskOnly.userId]);
    await client.query("UPDATE access_trial_members SET level='l1',record_version=record_version+1 WHERE user_id=$1",[taskOnly.userId]);
    await client.query("UPDATE access_role_bindings SET status='revoked',record_version=record_version+1 WHERE user_id=$1 AND status='active'",[taskOnly.userId]);
    await client.query(`INSERT INTO access_role_bindings
      (id,organization_id,membership_id,user_id,role,status,created_by_user_id)
      VALUES (gen_random_uuid(),$1,$2,$3,'l1','active',$4)`,[org,taskOnly.membershipId,taskOnly.userId,root.userId]);
    assert.ok(await service.detail(business,first.id));
    await assert.rejects(async()=>service.detail(taskOnly,first.id),rejected("TASK_FORBIDDEN"));
    await client.query("ROLLBACK TO SAVEPOINT disabled_recipient");
    await client.query("RELEASE SAVEPOINT disabled_recipient");
    const failing=new TaskWorkspaceService(new PostgresqlTaskWorkspaceRepository(runner,{ failBeforeCommit(){ throw new Error("synthetic audit rollback"); } }));
    const count=(await client.query("SELECT count(*)::int AS n FROM tasks_tasks")).rows[0]!.n;
    await assert.rejects(async()=>failing.create({ actor:root,command:command(caseId) }),rejected("TASK_UNAVAILABLE"));
    assert.equal((await client.query("SELECT count(*)::int AS n FROM tasks_tasks")).rows[0]!.n,count);
    await client.query("SELECT set_config('app.actor_user_id',$1,true)",[root.userId]);
    await client.query("UPDATE access_trial_members SET categories='{}',record_version=record_version+1 WHERE user_id=$1",[restricted.userId]);
    assert.equal((await service.list(restricted,null)).tasks.length,0);
    await assert.rejects(async()=>service.create(firstInput),rejected("TASK_NOT_FOUND"));
    const revoke={actor:business,taskId:first.id,command:{assignmentId:completed!.task.currentAssignment!.id,
      expectedRecordVersion:3,reason:"Synthetic completed access revoke",...keys()}};
    assert.deepEqual((await service.detail(business,first.id))!.task.allowedActions,["revoke_access"]);
    await assert.rejects(async()=>service.revokeCompletedAssignment({...revoke,actor:taskOnly}),rejected("TASK_FORBIDDEN"));
    await assert.rejects(async()=>service.revokeCompletedAssignment({...revoke,actor:restricted}),rejected("TASK_FORBIDDEN"));
    await assert.rejects(service.revokeCompletedAssignment({...revoke,command:{...revoke.command,expectedRecordVersion:2,...keys()}}),rejected("TASK_STALE_VERSION"));
    await assert.rejects(service.revokeCompletedAssignment({...revoke,command:{...revoke.command,assignmentId:randomUUID(),...keys()}}),rejected("TASK_CONFLICT"));
    await assert.rejects(failing.revokeCompletedAssignment({...revoke,actor:root,command:{...revoke.command,...keys()}}),rejected("TASK_UNAVAILABLE"));
    assert.equal((await service.detail(taskOnly,first.id))!.task.recordVersion,3,"failed revocation rolls back access and version");
    const beforeReceipts=(await client.query("SELECT count(*)::int AS n FROM tasks_task_transition_receipts WHERE task_id=$1",[first.id])).rows[0]!.n;
    const revoked=await service.revokeCompletedAssignment(revoke);
    assert.equal(revoked.recordVersion,4);
    assert.deepEqual(await service.revokeCompletedAssignment(revoke),revoked);
    assert.equal(await service.detail(taskOnly,first.id),null,"completed read access ends immediately");
    const history=await service.detail(business,first.id);
    assert.equal(history!.task.state,"completed"); assert.equal(history!.task.currentAssignment,null);
    assert.deepEqual(history!.task.allowedActions,[]);
    assert.equal((await client.query("SELECT count(*)::int AS n FROM tasks_task_transition_receipts WHERE task_id=$1",[first.id])).rows[0]!.n,beforeReceipts,"completion receipts are preserved");
    assert.equal((await client.query("SELECT count(*)::int AS n FROM audit_events WHERE event_type='tasks.assignment_access_revoked' AND resource_id=$1",[first.id])).rows[0]!.n,1);
    process.stdout.write(JSON.stringify({ trial_manual_tasks:"pass", l3:"cross_category_task_only", completed:"readonly_until_revoked", reject_cancel_revoke:"denied", stale_scope:"denied", rollback:"atomic" })+"\n");
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT trial_task_fixture");
    await client.query("RELEASE SAVEPOINT trial_task_fixture");
  }
}
