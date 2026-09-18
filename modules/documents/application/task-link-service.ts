import { randomUUID } from "node:crypto";
import type { IdentitySessionActor } from "../../identity/public.ts";
import { hashRequestPayload,validateIdempotencyKey } from "../../shared/public.ts";
import { buildAtomicMutationEffects,buildAuditEvent,buildOutboxMessage,type MutationEffectBundle } from "../../audit/public.ts";
import { DocumentWorkspaceError } from "./workspace-service.ts";

export const TASK_DOCUMENT_ACTIONS=["document.read","document.upload","document.download"] as const;
export type TaskDocumentAction=typeof TASK_DOCUMENT_ACTIONS[number];
export interface TaskDocumentLinkView {
  readonly id:string; readonly documentId:string; readonly displayName:string;
  readonly recordVersion:number; readonly allowedActions:readonly TaskDocumentAction[];
  readonly availableVersion:boolean; readonly configuredActions?:readonly TaskDocumentAction[];
}
export interface TaskDocumentLinksView {readonly canManage:boolean;readonly canGrant:boolean;readonly options:readonly {id:string;displayName:string}[];readonly links:readonly TaskDocumentLinkView[];}
export interface TaskDocumentLinkWrite {
  readonly actor:IdentitySessionActor;readonly taskId:string;readonly documentId:string;
  readonly allowedActions:readonly TaskDocumentAction[];readonly expectedRecordVersion:number;
  readonly reason:string;readonly requestId:string;readonly idempotencyKey:string;
}
export interface TaskDocumentLinkRepository {
  list(actor:IdentitySessionActor,taskId:string):Promise<TaskDocumentLinksView>;
  set(input:TaskDocumentLinkWrite & {readonly id:string;readonly requestHash:string;readonly effects:MutationEffectBundle}):Promise<{readonly id:string;readonly recordVersion:number}>;
}
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export class TaskDocumentLinkService {
  private readonly repository:TaskDocumentLinkRepository;
  constructor(repository:TaskDocumentLinkRepository){this.repository=repository;}
  list(actor:IdentitySessionActor,taskId:string) {
    if(!UUID.test(taskId)) throw new DocumentWorkspaceError("DOCUMENT_WORKSPACE_INVALID");
    return this.repository.list(actor,taskId);
  }
  set(input:TaskDocumentLinkWrite) {
    if (!UUID.test(input.taskId) || !UUID.test(input.documentId)
      || !Number.isSafeInteger(input.expectedRecordVersion) || input.expectedRecordVersion<0
      || typeof input.reason!=="string" || input.reason!==input.reason.trim() || !input.reason || input.reason.length>4000
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.requestId)
      || !Array.isArray(input.allowedActions) || input.allowedActions.some(a=>!TASK_DOCUMENT_ACTIONS.includes(a))
      || new Set(input.allowedActions).size!==input.allowedActions.length
      || (input.allowedActions.length>0 && !input.allowedActions.includes("document.read"))) {
      throw new DocumentWorkspaceError("DOCUMENT_WORKSPACE_INVALID");
    }
    try {validateIdempotencyKey(input.idempotencyKey);} catch {throw new DocumentWorkspaceError("DOCUMENT_WORKSPACE_INVALID");}
    const id=randomUUID(),occurredAt=new Date().toISOString();
    const audit=buildAuditEvent({id:randomUUID(),organizationId:input.actor.organizationId,actorUserId:input.actor.userId,
      actorKind:"user",eventType:"documents.task_link_changed",eventVersion:1,action:"update",resourceType:"Task",
      resourceId:input.taskId,outcome:"succeeded",requestId:input.requestId,occurredAt,
      metadata:{document_id:input.documentId,status:input.allowedActions.length ? input.allowedActions.join(":") : "revoked",record_version:input.expectedRecordVersion+1}});
    const outbox=buildOutboxMessage({id:randomUUID(),auditEventId:audit.id,organizationId:input.actor.organizationId,
      eventType:audit.eventType,eventVersion:1,aggregateType:"Task",aggregateId:input.taskId,idempotencyKey:`task-link-${audit.id}`,requestId:input.requestId,availableAt:occurredAt,createdAt:occurredAt,
      payload:{aggregate_id:input.taskId,request_id:input.requestId,document_id:input.documentId,status:input.allowedActions.length ? input.allowedActions.join(":") : "revoked",record_version:input.expectedRecordVersion+1}});
    return this.repository.set({...input,id,requestHash:hashRequestPayload({task_id:input.taskId,document_id:input.documentId,
      allowed_actions:[...input.allowedActions].sort(),expected_record_version:input.expectedRecordVersion,reason:input.reason}),
      effects:buildAtomicMutationEffects({audit,outbox})});
  }
}
