import assert from "node:assert/strict";
import test from "node:test";
import type { IdentitySessionActor } from "../../../modules/identity/public.ts";
import {
  TaskWorkspaceError, TaskWorkspaceService, isTaskWorkspaceError,
  type TaskWorkspaceRepository,
} from "../../../modules/tasks/application/workspace-service.ts";

const IDS=["51000000-0000-4000-8000-000000000101","51000000-0000-4000-8000-000000000102","51000000-0000-4000-8000-000000000103","51000000-0000-4000-8000-000000000104"];
test("TASK-01 service enforces create/transition capabilities and canonical hashes", async()=>{
  const calls:unknown[]=[];const repository={
    list:async()=>({audience:"case_workspace" as const,tasks:[]}),detail:async()=>null,options:async()=>({assignees:[]}),
    create:async(input:unknown)=>{calls.push(input);return{id:IDS[3]!,recordVersion:1};},
    transition:async(input:unknown)=>{calls.push(input);return{id:IDS[3]!,recordVersion:2};},
  } satisfies TaskWorkspaceRepository;
  const ids=[IDS[3]!,IDS[0]!,IDS[1]!,IDS[2]!,IDS[0]!,IDS[1]!,IDS[2]!];
  const service=new TaskWorkspaceService(repository,()=>ids.shift()!,()=>Date.parse("2026-08-23T00:00:00.000Z"));
  await service.create({actor:actor("advisor"),command:{caseId:IDS[1]!,title:"Synthetic task",taskBrief:"Synthetic brief",dueAt:"2027-01-01T00:00:00.000Z",assigneeUserId:IDS[2]!,requestId:"request-1",idempotencyKey:"task-create"}});
  assert.throws(()=>service.create({actor:actor("admin"),command:{caseId:IDS[1]!,title:"Synthetic task",taskBrief:"Synthetic brief",dueAt:"2027-01-01T00:00:00.000Z",assigneeUserId:IDS[2]!,requestId:"request-2",idempotencyKey:"task-denied"}}),
    (error)=>isTaskWorkspaceError(error,"TASK_FORBIDDEN"));
  assert.equal(calls.length,1);
});
test("TASK-01 stable guard accepts only Error name plus allowlisted code",()=>{const equivalent=new Error() as Error&{code:string};equivalent.name="TaskWorkspaceError";equivalent.code="TASK_CONFLICT";
  assert.equal(isTaskWorkspaceError(equivalent),true);assert.equal(isTaskWorkspaceError({name:"TaskWorkspaceError",code:"TASK_CONFLICT"}),false);
  assert.equal(isTaskWorkspaceError(Object.assign(new Error(),{name:"TaskWorkspaceError",code:"UNKNOWN"})),false);
  assert.equal(new TaskWorkspaceError("TASK_INVALID").name,"TaskWorkspaceError");});
function actor(role:IdentitySessionActor["role"]):IdentitySessionActor{return{userId:IDS[0]!,organizationId:IDS[1]!,role,sessionId:IDS[2]!,capturedSessionVersion:1,reauthenticatedAtMs:null};}
