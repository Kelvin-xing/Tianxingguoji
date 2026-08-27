import { randomUUID } from "node:crypto";
import { hasRequestCapability, type RequestAccessActor } from "../../access/public.ts";
import { buildAtomicMutationEffects, buildAuditEvent, buildOutboxMessage, type MutationEffectBundle } from "../../audit/public.ts";
import { hashRequestPayload, validateIdempotencyKey, type JsonValue } from "../../shared/public.ts";

export interface ApplicationSubmissionCompletion {
  readonly submitted_at: string; readonly submission_channel: string; readonly submitter_user_id: string;
  readonly checklist_snapshot: unknown; readonly official_submission_reference?: string | null;
  readonly no_reference_declared?: boolean;
}
export interface SchoolTargetWorkflowRepository {
  recordApplicationSubmission(input: {
    readonly actor: RequestAccessActor; readonly caseId: string; readonly targetId: string; readonly taskId: string;
    readonly completionReceiptId: string; readonly evidenceReference: string; readonly completion: ApplicationSubmissionCompletion;
    readonly expectedTargetRecordVersion: number; readonly requestId: string; readonly idempotencyKey: string;
    readonly requestHash: string; readonly transitionFactId: string; readonly idempotencyRecordId: string;
    readonly occurredAt: string; readonly effects: MutationEffectBundle;
  }): Promise<{ readonly id: string; readonly recordVersion: number; readonly state: string }>;
}
export class SchoolTargetWorkflowError extends Error {
  readonly code: "INVALID" | "FORBIDDEN" | "NOT_FOUND" | "STALE_VERSION" | "CONFLICT" | "UNAVAILABLE";

  constructor(code: "INVALID" | "FORBIDDEN" | "NOT_FOUND" | "STALE_VERSION" | "CONFLICT" | "UNAVAILABLE") {
    super(`School target workflow rejected ${code}.`); this.name = "SchoolTargetWorkflowError";
    this.code = code;
  }
}
export class SchoolTargetWorkflowService {
  private readonly repository: SchoolTargetWorkflowRepository;
  private readonly now: () => number;
  private readonly createId: () => string;

  constructor(repository: SchoolTargetWorkflowRepository,
    now: () => number = Date.now, createId: () => string = randomUUID) {
    this.repository = repository;
    this.now = now;
    this.createId = createId;
  }
  recordApplicationSubmission(input: {
    readonly actor: RequestAccessActor; readonly caseId: string; readonly targetId: string; readonly taskId: string;
    readonly completionReceiptId: string; readonly evidenceReference: string; readonly completion: ApplicationSubmissionCompletion;
    readonly expectedTargetRecordVersion: number; readonly requestId: string; readonly idempotencyKey: string;
  }) {
    if (!hasRequestCapability(input.actor,"cases.workflow.manage")) forbidden();
    for (const value of [input.caseId,input.targetId,input.taskId,input.completionReceiptId,input.evidenceReference]) uuid(value);
    if (!Number.isSafeInteger(input.expectedTargetRecordVersion) || input.expectedTargetRecordVersion < 1 ||
        !Number.isFinite(Date.parse(input.completion.submitted_at)) || !input.completion.submission_channel ||
        !input.completion.submitter_user_id || typeof input.completion.checklist_snapshot !== "object") invalid();
    try { validateIdempotencyKey(input.idempotencyKey); } catch { invalid(); }
    const occurredAt = new Date(this.now()).toISOString(); const auditId = this.createId(); const outboxId = this.createId();
    uuid(auditId); uuid(outboxId);
    const effects = effectsFor(input.actor,input.targetId,input.requestId,occurredAt,auditId,outboxId,input.expectedTargetRecordVersion+1);
    return this.repository.recordApplicationSubmission({ ...input, requestHash: hashRequestPayload({ case_id: input.caseId,
      target_id: input.targetId, task_id: input.taskId, receipt_id: input.completionReceiptId,
      expected_record_version: input.expectedTargetRecordVersion, evidence_reference: input.evidenceReference,
      completion: input.completion as unknown as JsonValue }), transitionFactId: this.createId(), idempotencyRecordId: this.createId(),
      occurredAt, effects });
  }
}
function effectsFor(actor: RequestAccessActor, targetId: string, requestId: string, occurredAt: string,
  auditId: string, outboxId: string, version: number): MutationEffectBundle {
  const audit = buildAuditEvent({ id:auditId,organizationId:actor.organizationId,actorUserId:actor.userId,actorKind:"user",
    eventType:"cases.application_submission_recorded",eventVersion:1,action:"transition",resourceType:"SchoolTarget",
    resourceId:targetId,outcome:"succeeded",requestId,occurredAt,metadata:{effect_type:"application_submission_recorded",record_version:version,status:"submitted"} });
  const outbox = buildOutboxMessage({ id:outboxId,auditEventId:auditId,organizationId:actor.organizationId,aggregateType:"SchoolTarget",
    aggregateId:targetId,eventType:"cases.application_submission_recorded",eventVersion:1,idempotencyKey:`target-${auditId}`,
    requestId,payload:{aggregate_id:targetId,record_version:version,status:"submitted",effect_type:"application_submission_recorded"},availableAt:occurredAt,createdAt:occurredAt });
  return buildAtomicMutationEffects({audit,outbox});
}
function uuid(value:string):void{if(!/^[0-9a-f-]{36}$/i.test(value))invalid();}
function invalid():never{throw new SchoolTargetWorkflowError("INVALID");}
function forbidden():never{throw new SchoolTargetWorkflowError("FORBIDDEN");}
