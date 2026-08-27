import assert from "node:assert/strict";
import test from "node:test";

import {
  acknowledgementData, collectionData, mapTaskError, parseTaskCreate,
  parseTaskListQuery, parseTaskTransition,
} from "../../app/api/v1/tasks/handler.ts";
import { TaskWorkspaceError } from "../../modules/tasks/application/workspace-service.ts";

const ID = "51000000-0000-4000-8000-000000000101";
test("TASK-01 route parsers enforce exact query and write DTOs", async () => {
  assert.equal(parseTaskListQuery(new Request(`http://local/api/v1/tasks?case_id=${ID}`)), ID);
  assert.throws(() => parseTaskListQuery(new Request("http://local/api/v1/tasks?role=founder")));
  const create = await parseTaskCreate(jsonRequest("http://local/api/v1/tasks", {
    case_id: ID,title: "Synthetic task",task_brief: "Synthetic brief",
    due_at: "2027-01-01T00:00:00.000Z",assignee_user_id: ID,
  }), "task-request");
  assert.deepEqual(Object.keys(create).sort(), ["assigneeUserId","caseId","dueAt","idempotencyKey","requestId","taskBrief","title"].sort());
  await assert.rejects(() => parseTaskCreate(jsonRequest("http://local/api/v1/tasks", {
    case_id: ID,title: "Synthetic task",task_brief: "Synthetic brief",
    due_at: "2027-01-01T00:00:00.000Z",assignee_user_id: ID,organization_id: ID,
  }), "task-request"));
  const transition = await parseTaskTransition(jsonRequest(`http://local/api/v1/tasks/${ID}/transitions`, {
    to:"accepted",expected_record_version:1,reason:"",next_assignee_user_id:null,
  }), ID, "transition-request");
  assert.equal(transition.to, "accepted");
});

test("TASK-01 response mappers preserve exact internal and Contractor projections", () => {
  const common = { id:ID,title:"Synthetic task",taskBrief:"Synthetic brief",dueAt:"2027-01-01T00:00:00.000Z",
    state:"assigned" as const,recordVersion:1,updatedAt:"2026-08-23T00:00:00.000Z",availableTransitions:[],taskKind:"manual" as const,
    schoolTargetId:null,isOverdue:false,currentAssignment:null,allowedActions:[] as const };
  const internal = collectionData({ audience:"case_workspace",tasks:[{...common,caseId:ID,caseNumber:"CASE-1",
    assignee:{id:ID,role:"advisor",label:"Advisor · synthetic"}}] });
  const assigned = collectionData({ audience:"assigned_task",tasks:[common] });
  assert.deepEqual(Object.keys((internal as {tasks:Record<string,unknown>[]}).tasks[0]!).sort(),
    ["id","case_id","case_number","title","task_brief","due_at","state","assignee","record_version","updated_at","available_transitions","task_kind","school_target_id","is_overdue","current_assignment","allowed_actions"].sort());
  assert.deepEqual(Object.keys((assigned as {tasks:Record<string,unknown>[]}).tasks[0]!).sort(),
    ["id","title","task_brief","due_at","state","record_version","updated_at","available_transitions","task_kind","school_target_id","is_overdue","current_assignment","allowed_actions"].sort());
  assert.deepEqual(acknowledgementData({id:ID,recordVersion:2}),{id:ID,record_version:2});
});

test("TASK-01 stable error guard maps HMR-equivalent errors and rejects unknown objects", () => {
  const equivalent = new Error("redacted") as Error & {code:string}; equivalent.name="TaskWorkspaceError";equivalent.code="TASK_FORBIDDEN";
  assert.equal((mapTaskError(equivalent) as {code:string}).code,"FORBIDDEN");
  const plain={name:"TaskWorkspaceError",code:"TASK_FORBIDDEN"};assert.equal(mapTaskError(plain),plain);
  assert.equal(mapTaskError(new TaskWorkspaceError("TASK_STALE_VERSION")) instanceof Error,true);
});

function jsonRequest(url:string,body:unknown){return new Request(url,{method:"POST",headers:{"content-type":"application/json","idempotency-key":"task-key"},body:JSON.stringify(body)});}
