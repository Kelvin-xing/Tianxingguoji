import {
  TaskWorkspaceError, isTaskWorkflowRuntimeUnavailable, isTaskWorkspaceError,
  type TaskAcknowledgement, type TaskAssigneeView, type TaskCollectionView,
  type TaskDetailView, type TaskOptionsView, type TaskView,
} from "../../../../modules/tasks/server.ts";
import { createApiError, type JsonValue } from "../../../../modules/shared/public.ts";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CREATE_KEYS=["assignee_user_id","case_id","due_at","task_brief","title"] as const;
const TRANSITION_KEYS=["expected_record_version","next_assignee_user_id","reason","to"] as const;
export function parseTaskListQuery(request:Request):string|null{const url=new URL(request.url);const keys=[...url.searchParams.keys()];
  if(keys.some((key)=>key!=="case_id")||url.searchParams.getAll("case_id").length>1)invalid();const id=url.searchParams.get("case_id");if(id!==null&&!UUID.test(id))invalid();return id;}
export function parseTaskOptionsQuery(request:Request):string{const value=parseTaskListQuery(request);if(!value)invalid();return value;}
export async function parseTaskCreate(request:Request,requestId:string){const body=await exactJson(request,CREATE_KEYS);const key=idempotencyKey(request);
  if(![body.case_id,body.title,body.task_brief,body.due_at,body.assignee_user_id].every((value)=>typeof value==="string"))invalid();
  return Object.freeze({caseId:body.case_id as string,title:body.title as string,taskBrief:body.task_brief as string,
    dueAt:body.due_at as string,assigneeUserId:body.assignee_user_id as string,requestId,idempotencyKey:key});}
export async function parseTaskTransition(request:Request,taskId:string,requestId:string){if(!UUID.test(taskId))invalid();const body=await exactJson(request,TRANSITION_KEYS);const key=idempotencyKey(request);
  if(typeof body.to!=="string"||typeof body.expected_record_version!=="number"||typeof body.reason!=="string"||
    (body.next_assignee_user_id!==null&&typeof body.next_assignee_user_id!=="string"))invalid();return Object.freeze({to:body.to as never,
    expectedRecordVersion:body.expected_record_version,reason:body.reason,nextAssigneeUserId:body.next_assignee_user_id,requestId,idempotencyKey:key});}
export function collectionData(value:TaskCollectionView):JsonValue{return{audience:value.audience,tasks:value.tasks.map((task)=>taskData(task,value.audience))};}
export function detailData(value:TaskDetailView):JsonValue{return{audience:value.audience,task:taskData(value.task,value.audience)};}
export function optionsData(value:TaskOptionsView):JsonValue{return{assignees:value.assignees.map(assigneeData)};}
export function acknowledgementData(value:TaskAcknowledgement):JsonValue{return{id:value.id,record_version:value.recordVersion};}
function taskData(value:TaskView,audience:TaskCollectionView["audience"]):JsonValue{const base={id:value.id,title:value.title,task_brief:value.taskBrief,due_at:value.dueAt,state:value.state,
  record_version:value.recordVersion,updated_at:value.updatedAt,available_transitions:value.availableTransitions.map((item)=>({to:item.to,requires_reason:item.requiresReason,requires_assignee:item.requiresAssignee}))};
  if(audience==="assigned_task")return base;const internal=value as TaskView&{caseId:string;caseNumber:string;assignee:TaskAssigneeView};return{id:base.id,case_id:internal.caseId,
    case_number:internal.caseNumber,title:base.title,task_brief:base.task_brief,due_at:base.due_at,state:base.state,assignee:assigneeData(internal.assignee),record_version:base.record_version,
    updated_at:base.updated_at,available_transitions:base.available_transitions};}
function assigneeData(value:TaskAssigneeView):JsonValue{return{id:value.id,role:value.role,label:value.label};}
export function mapTaskError(error:unknown):unknown{if(isTaskWorkflowRuntimeUnavailable(error))return createApiError("SERVICE_UNAVAILABLE");if(!isTaskWorkspaceError(error))return error;
  switch(error.code){case"TASK_FORBIDDEN":return createApiError("FORBIDDEN");case"TASK_INVALID":return createApiError("VALIDATION_FAILED");case"TASK_NOT_FOUND":return createApiError("NOT_FOUND");
    case"TASK_STALE_VERSION":return createApiError("STALE_VERSION");case"TASK_CONFLICT":return createApiError("CONFLICT");case"TASK_POLICY_UNAVAILABLE":case"TASK_UNAVAILABLE":return createApiError("SERVICE_UNAVAILABLE");}}
async function exactJson(request:Request,keys:readonly string[]):Promise<Record<string,unknown>>{if(request.headers.get("content-type")?.split(";",1)[0]?.trim()!=="application/json")invalid();
  let value:unknown;try{value=await request.json();}catch{invalid();}if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).sort().join(",")!==[...keys].sort().join(","))invalid();return value as Record<string,unknown>;}
function idempotencyKey(request:Request):string{const value=request.headers.get("idempotency-key");if(!value)invalid();return value;}
function invalid():never{throw new TaskWorkspaceError("TASK_INVALID");}
