import { randomUUID } from "node:crypto";
import { hasRequestCapability, type RequestAccessActor } from "../../access/public.ts";
import { buildAuditEvent, buildOutboxMessage, buildAtomicMutationEffects, type MutationEffectBundle } from "../../audit/public.ts";
import { hashRequestPayload, validateIdempotencyKey } from "../../shared/public.ts";

export interface InterviewInvitationCommand {
  readonly actor: RequestAccessActor;
  readonly caseId: string;
  readonly targetId: string;
  readonly expectedRecordVersion: number;
  readonly interviewAt: string;
  readonly interviewMethod:string;
  readonly interviewLanguage:string;
  readonly coachingRequirements:string;
  readonly backgroundSummary:string;
  readonly invitationDocumentId: string;
  readonly requestId: string;
  readonly idempotencyKey: string;
}
export interface InterviewInvitationResult {
  readonly targetId: string;
  readonly recordVersion: number;
  readonly state: "interview";
  readonly invitationId: string;
}
export interface InterviewInvitationWrite extends InterviewInvitationCommand {
  readonly invitationId: string;
  readonly idempotencyRecordId: string;
  readonly requestHash: string;
  readonly occurredAt: string;
  readonly effects: MutationEffectBundle;
}
export interface InterviewInvitationRepository {
  record(input: InterviewInvitationWrite): Promise<InterviewInvitationResult>;
}
export class InterviewInvitationError extends Error {
  readonly code: "INVALID" | "FORBIDDEN" | "NOT_FOUND" | "CONFLICT" | "STALE_VERSION" | "EVIDENCE_REQUIRED" | "UNAVAILABLE";
  constructor(code: InterviewInvitationError["code"]) {
    super(`Interview invitation rejected ${code}.`); this.name = "InterviewInvitationError"; this.code=code;
  }
}
export class InterviewInvitationService {
  private readonly repository: InterviewInvitationRepository;
  constructor(repository: InterviewInvitationRepository) { this.repository=repository; }
  async record(input: InterviewInvitationCommand): Promise<InterviewInvitationResult> {
    if (!hasRequestCapability(input.actor,"cases.workflow.manage")) throw new InterviewInvitationError("FORBIDDEN");
    const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (![input.caseId,input.targetId,input.invitationDocumentId].every(value=>uuid.test(value)) ||
      !Number.isSafeInteger(input.expectedRecordVersion) || input.expectedRecordVersion<1 ||
      !/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(input.interviewAt) || !Number.isFinite(Date.parse(input.interviewAt)) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.requestId)) throw new InterviewInvitationError("INVALID");
    for(const [value,max] of [[input.interviewMethod,200],[input.interviewLanguage,200],[input.coachingRequirements,1500],[input.backgroundSummary,1500]] as const) {
      if(typeof value!=="string"||value.trim().length<1||value.length>max)throw new InterviewInvitationError("INVALID");
    }
    try { validateIdempotencyKey(input.idempotencyKey); } catch { throw new InterviewInvitationError("INVALID"); }
    const invitationId=randomUUID(), occurredAt=new Date().toISOString(), auditId=randomUUID();
    const eventType="cases.interview_invitation_recorded", version=input.expectedRecordVersion+1;
    const interviewAt=new Date(input.interviewAt).toISOString();
    const audit=buildAuditEvent({id:auditId,organizationId:input.actor.organizationId,actorUserId:input.actor.userId,
      actorKind:"user",eventType,eventVersion:1,action:"transition",resourceType:"SchoolTarget",resourceId:input.targetId,
      outcome:"succeeded",requestId:input.requestId,occurredAt,metadata:{effect_type:eventType,record_version:version,status:"interview"}});
    const outbox=buildOutboxMessage({id:randomUUID(),auditEventId:auditId,organizationId:input.actor.organizationId,
      aggregateType:"SchoolTarget",aggregateId:input.targetId,eventType,eventVersion:1,idempotencyKey:`interview-${invitationId}`,
      requestId:input.requestId,payload:{aggregate_id:input.targetId,request_id:input.requestId,record_version:version,status:"interview",effect_type:eventType},
      availableAt:occurredAt,createdAt:occurredAt});
    return this.repository.record({...input,interviewAt,invitationId,idempotencyRecordId:randomUUID(),occurredAt,
      requestHash:hashRequestPayload({case_id:input.caseId,target_id:input.targetId,expected_record_version:input.expectedRecordVersion,
        interview_at:interviewAt,invitation_document_id:input.invitationDocumentId,interview_method:input.interviewMethod,interview_language:input.interviewLanguage,coaching_requirements:input.coachingRequirements,background_summary:input.backgroundSummary}),effects:buildAtomicMutationEffects({audit,outbox})});
  }
}
