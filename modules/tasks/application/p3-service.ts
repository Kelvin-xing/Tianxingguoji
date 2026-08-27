import { randomUUID } from "node:crypto";

import { hasRequestCapability, type RequestAccessActor } from "../../access/public.ts";
import { buildAtomicMutationEffects, buildAuditEvent, buildOutboxMessage,
  hashRedactedSnapshot, type MutationEffectBundle } from "../../audit/public.ts";
import { hashRequestPayload, validateIdempotencyKey, type JsonValue } from "../../shared/public.ts";

export type P3TaskKind = "application_prepare_submit" | "interview_support";
export type P3TaskState = "assigned" | "accepted" | "awaiting_reassignment" | "completed" | "cancelled";
export type P3TaskAction = "accept" | "reject" | "reassign" | "cancel" | "complete";
export type P3CompletionRecord = Readonly<Record<string, unknown>>;

export interface P3TaskAcknowledgement {
  readonly id: string; readonly recordVersion: number; readonly state: P3TaskState;
  readonly kind?: P3TaskKind; readonly schoolTargetId?: string; readonly completionReceiptId?: string;
}

export interface P3TaskRepository {
  ensureTargetTask(input: P3EnsureTargetTaskRepositoryInput): Promise<P3TaskAcknowledgement>;
  transitionTargetTask(input: P3TransitionTargetTaskRepositoryInput): Promise<P3TaskAcknowledgement>;
}

export interface P3EnsureTargetTaskRepositoryInput {
  readonly actor: RequestAccessActor; readonly taskId: string; readonly taskKey: string;
  readonly kind: P3TaskKind; readonly caseId: string; readonly targetId: string;
  readonly assignmentId: string; readonly sourceEventId: string;
  readonly dueAt: string; readonly title: string; readonly brief: string; readonly requestId: string;
  readonly idempotencyKey: string; readonly requestHash: string; readonly idempotencyRecordId: string; readonly effects: MutationEffectBundle;
}

export interface P3TransitionTargetTaskRepositoryInput {
  readonly actor: RequestAccessActor; readonly taskId: string; readonly action: P3TaskAction;
  readonly expectedRecordVersion: number; readonly reason: string; readonly nextAssigneeUserId: string | null;
  readonly completionRecord: P3CompletionRecord | null; readonly evidenceReference: string | null;
  readonly requestId: string; readonly idempotencyKey: string; readonly requestHash: string;
  readonly receiptId: string; readonly idempotencyRecordId: string; readonly effects: MutationEffectBundle;
}

export class P3TaskError extends Error {
  readonly code: "INVALID" | "FORBIDDEN" | "NOT_FOUND" | "CONFLICT" | "STALE_VERSION" | "COMPLETION_INVALID" | "UNAVAILABLE";
  constructor(code:
    | "INVALID" | "FORBIDDEN" | "NOT_FOUND" | "CONFLICT" | "STALE_VERSION" | "COMPLETION_INVALID" | "UNAVAILABLE") {
    super(`P3 task command rejected ${code}.`); this.name = "P3TaskError"; this.code = code;
  }
}

export class P3TaskService {
  private readonly repository: P3TaskRepository;
  private readonly now: () => number;
  private readonly createId: () => string;
  constructor(repository: P3TaskRepository, now: () => number = Date.now,
    createId: () => string = randomUUID) { this.repository = repository; this.now = now; this.createId = createId; }

  ensureTargetTask(input: {
    readonly actor: RequestAccessActor; readonly kind: P3TaskKind; readonly caseId: string;
    readonly targetId: string; readonly assignmentId: string; readonly sourceEventId: string;
    readonly dueAt: string; readonly title: string; readonly brief: string;
    readonly taskKey: string; readonly requestId: string; readonly idempotencyKey: string;
  }): Promise<P3TaskAcknowledgement> {
    assertActor(input.actor, "tasks.create");
    for (const value of [input.caseId,input.targetId,input.assignmentId,input.sourceEventId]) uuid(value);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.requestId) || input.title.trim() !== input.title ||
        input.title.length < 1 || input.title.length > 300 || input.brief.trim() !== input.brief ||
        input.brief.length < 1 || input.brief.length > 4_000 || Number.isNaN(Date.parse(input.dueAt)) ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.taskKey)) bad();
    key(input.idempotencyKey);
    const occurredAt = checkedTime(this.now()); const taskId = this.createId(); const auditId = this.createId();
    const outboxId = this.createId(); const idempotencyRecordId = this.createId(); uuid(taskId); uuid(auditId); uuid(outboxId); uuid(idempotencyRecordId);
    const effects = effectsFor(input.actor, taskId, input.requestId, occurredAt, auditId, outboxId,
      "tasks.task_created", "assigned", 1);
    return this.repository.ensureTargetTask({ ...input, actor: input.actor, taskId, idempotencyRecordId, requestHash: hashRequestPayload({
      case_id: input.caseId, target_id: input.targetId, task_key: input.taskKey, kind: input.kind,
      source_event_id: input.sourceEventId,
    }), effects });
  }

  transitionTargetTask(input: {
    readonly actor: RequestAccessActor; readonly taskId: string; readonly action: P3TaskAction;
    readonly expectedRecordVersion: number; readonly reason?: string; readonly nextAssigneeUserId?: string | null;
    readonly completionRecord?: P3CompletionRecord | null; readonly evidenceReference?: string | null;
    readonly requestId: string; readonly idempotencyKey: string;
  }): Promise<P3TaskAcknowledgement> {
    assertActor(input.actor, "tasks.transition"); uuid(input.taskId);
    if (!Number.isSafeInteger(input.expectedRecordVersion) || input.expectedRecordVersion < 1 ||
        !["accept","reject","reassign","cancel","complete"].includes(input.action)) bad();
    const reason = (input.reason ?? "").trim();
    if (["reject","reassign","cancel"].includes(input.action) && reason.length === 0) bad();
    if (input.action === "reassign") { if (!input.nextAssigneeUserId) bad(); uuid(input.nextAssigneeUserId); }
    if (input.action === "complete") validateCompletion(input.completionRecord ?? null, input.evidenceReference ?? null);
    key(input.idempotencyKey);
    const occurredAt = checkedTime(this.now()); const receiptId = this.createId(); uuid(receiptId);
    const auditId = this.createId(); const outboxId = this.createId(); const idempotencyRecordId = this.createId(); uuid(auditId); uuid(outboxId); uuid(idempotencyRecordId);
    const next = input.action === "accept" ? "accepted" : input.action === "complete" ? "completed" :
      input.action === "cancel" ? "cancelled" : input.action === "reassign" ? "assigned" : "awaiting_reassignment";
    const event = input.action === "complete" ? completionEvent(input.completionRecord ?? null) : "tasks.task_transitioned";
    const effects = effectsFor(input.actor, input.taskId, input.requestId, occurredAt, auditId, outboxId,
      event, next, input.expectedRecordVersion + 1);
    return this.repository.transitionTargetTask({ ...input, actor: input.actor, idempotencyRecordId, reason,
      nextAssigneeUserId: input.nextAssigneeUserId ?? null, completionRecord: input.completionRecord ?? null,
      evidenceReference: input.evidenceReference ?? null, receiptId, requestHash: hashRequestPayload({
        task_id: input.taskId, action: input.action, expected_record_version: input.expectedRecordVersion,
        reason, next_assignee_user_id: input.nextAssigneeUserId ?? null,
        completion_record: (input.completionRecord ?? null) as JsonValue, evidence_reference: input.evidenceReference ?? null,
      }), effects });
  }
}

function assertActor(actor: RequestAccessActor, capability: "tasks.create" | "tasks.transition"): void {
  if (!actor || !/^[0-9a-f-]{36}$/i.test(actor.organizationId) || !/^[0-9a-f-]{36}$/i.test(actor.userId) ||
      !hasRequestCapability(actor, capability)) forbidden();
}
function validateCompletion(record: P3CompletionRecord | null, evidence: string | null): void {
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new P3TaskError("COMPLETION_INVALID");
  if (evidence !== null && !/^[0-9a-f-]{36}$/i.test(evidence)) throw new P3TaskError("COMPLETION_INVALID");
}
function completionEvent(record: P3CompletionRecord | null): string {
  return record && "submission_channel" in record
    ? "tasks.application_submission_completed"
    : "tasks.interview_support_completed";
}
function effectsFor(actor: RequestAccessActor, resourceId: string, requestId: string, occurredAt: string,
  auditId: string, outboxId: string, eventType: string, status: string, version: number): MutationEffectBundle {
  const audit = buildAuditEvent({ id: auditId, organizationId: actor.organizationId, actorUserId: actor.userId,
    actorKind: "user", eventType, eventVersion: 1, action: "transition", resourceType: "Task", resourceId,
    outcome: "succeeded", requestId, occurredAt, beforeHashSha256: hashRedactedSnapshot({ record_version: version }),
    afterHashSha256: hashRedactedSnapshot({ record_version: version, status }), metadata: { effect_type: eventType,
      record_version: version, status } });
  const outbox = buildOutboxMessage({ id: outboxId, auditEventId: auditId, organizationId: actor.organizationId,
    aggregateType: "Task", aggregateId: resourceId, eventType, eventVersion: 1,
    idempotencyKey: `task-${auditId}`, requestId, payload: { aggregate_id: resourceId,
      request_id: requestId, record_version: version, status, effect_type: eventType }, availableAt: occurredAt, createdAt: occurredAt });
  return buildAtomicMutationEffects({ audit, outbox });
}
function uuid(value: string | null | undefined): void { if (!value || !/^[0-9a-f-]{36}$/i.test(value)) bad(); }
function key(value: string): void { try { validateIdempotencyKey(value); } catch { bad(); } }
function checkedTime(value: number): string { if (!Number.isFinite(value) || value <= 0) bad(); return new Date(value).toISOString(); }
function bad(): never { throw new P3TaskError("INVALID"); }
function forbidden(): never { throw new P3TaskError("FORBIDDEN"); }
