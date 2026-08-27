import { randomUUID } from "node:crypto";

import {
  compatibilityRoleForRepository,
  type RequestAccessActor,
} from "../../access/public.ts";
import { buildAtomicMutationEffects, buildAuditEvent, buildOutboxMessage,
  type MutationEffectBundle } from "../../audit/public.ts";
import { hashRequestPayload, validateIdempotencyKey } from "../../shared/public.ts";
import type { ReferralSourceType } from "../../crm/public.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface CaseReferralSourceAssignmentView {
  readonly id: string;
  readonly referralSourceId: string;
  readonly sourceDisplayName: string;
  readonly sourceType: ReferralSourceType;
  readonly sourceRecordVersion: number;
  readonly startsAt: string;
  readonly endsAt: string | null;
  readonly recordVersion: number;
}
export interface CaseReferralSourceAssignmentsView {
  readonly current: CaseReferralSourceAssignmentView | null;
  readonly history: readonly CaseReferralSourceAssignmentView[];
}
export interface CaseReferralSourceAcknowledgement { readonly id: string; readonly recordVersion: number }
interface ActorInput { readonly organizationId: string; readonly actorUserId: string;
  readonly actorRole: string }

export interface CaseReferralSourceAssignmentRepository {
  read(input: ActorInput & { readonly caseId: string }): Promise<CaseReferralSourceAssignmentsView | null>;
  assign(input: ActorInput & {
    readonly caseId: string;
    readonly assignmentId: string;
    readonly referralSourceId: string;
    readonly expectedCurrentAssignmentRecordVersion: number | null;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly effects: MutationEffectBundle;
  }): Promise<CaseReferralSourceAcknowledgement>;
}

export type CaseReferralSourceErrorCode =
  | "CASE_REFERRAL_SOURCE_FORBIDDEN" | "CASE_REFERRAL_SOURCE_INVALID"
  | "CASE_REFERRAL_SOURCE_NOT_FOUND" | "CASE_REFERRAL_SOURCE_STALE"
  | "CASE_REFERRAL_SOURCE_CONFLICT" | "CASE_REFERRAL_SOURCE_UNAVAILABLE";
const ERROR_CODES = new Set<CaseReferralSourceErrorCode>([
  "CASE_REFERRAL_SOURCE_FORBIDDEN", "CASE_REFERRAL_SOURCE_INVALID",
  "CASE_REFERRAL_SOURCE_NOT_FOUND", "CASE_REFERRAL_SOURCE_STALE",
  "CASE_REFERRAL_SOURCE_CONFLICT", "CASE_REFERRAL_SOURCE_UNAVAILABLE",
]);
export class CaseReferralSourceError extends Error {
  readonly code: CaseReferralSourceErrorCode;
  constructor(code: CaseReferralSourceErrorCode) {
    super(`Case referral source rejected ${code}.`); this.name = "CaseReferralSourceError"; this.code = code;
  }
}
export function isCaseReferralSourceError(value: unknown, code?: CaseReferralSourceErrorCode): value is CaseReferralSourceError {
  if (!(value instanceof Error) || value.name !== "CaseReferralSourceError") return false;
  const candidate = (value as Error & { code?: unknown }).code;
  if (typeof candidate !== "string" || !ERROR_CODES.has(candidate as CaseReferralSourceErrorCode)) return false;
  return code === undefined || candidate === code;
}

export class CaseReferralSourceAssignmentService {
  private readonly repository: CaseReferralSourceAssignmentRepository;
  private readonly createId: () => string;
  private readonly now: () => number;
  constructor(repository: CaseReferralSourceAssignmentRepository,
    createId: () => string = randomUUID, now: () => number = Date.now) {
    this.repository = repository; this.createId = createId; this.now = now;
  }

  read(actor: RequestAccessActor, caseId: string) {
    const context = authorize(actor, "cases.read");
    if (!UUID.test(caseId)) invalid();
    return this.repository.read({ ...context, caseId });
  }

  assign(input: { readonly actor: RequestAccessActor; readonly command: {
    readonly caseId: string; readonly referralSourceId: string;
    readonly expectedCurrentAssignmentRecordVersion: number | null;
    readonly requestId: string; readonly idempotencyKey: string;
  } }) {
    const context = authorize(input.actor, "cases.referral_sources.assign");
    const command = input.command;
    if (!UUID.test(command.caseId) || !UUID.test(command.referralSourceId) ||
        (command.expectedCurrentAssignmentRecordVersion !== null &&
          (!Number.isSafeInteger(command.expectedCurrentAssignmentRecordVersion) ||
           command.expectedCurrentAssignmentRecordVersion < 1)) || !REQUEST_ID.test(command.requestId)) invalid();
    try { validateIdempotencyKey(command.idempotencyKey); } catch { invalid(); }
    const assignmentId = checkedId(this.createId);
    const resultingRecordVersion = command.expectedCurrentAssignmentRecordVersion === null ? 1 :
      command.expectedCurrentAssignmentRecordVersion + 1;
    const occurredAt = new Date(this.now()).toISOString();
    const auditId = checkedId(this.createId);
    const audit = buildAuditEvent({ id: auditId, organizationId: input.actor.organizationId,
      actorUserId: input.actor.userId, actorKind: "user", eventType: "cases.referral_source_assigned",
      eventVersion: 1, action: "assign", resourceType: "CaseReferralSourceAssignment",
      resourceId: assignmentId, outcome: "succeeded", requestId: command.requestId, occurredAt,
      metadata: { effect_type: "case.referral_source.assigned",
        record_version: resultingRecordVersion }, });
    const outbox = buildOutboxMessage({ id: checkedId(this.createId), auditEventId: auditId,
      organizationId: input.actor.organizationId, aggregateType: "CaseReferralSourceAssignment",
      aggregateId: assignmentId, eventType: "cases.referral_source_assigned", eventVersion: 1,
      idempotencyKey: `case-referral-source-${auditId}`, requestId: command.requestId,
      payload: { aggregate_id: assignmentId,
        effect_type: "case.referral_source.assigned", record_version: resultingRecordVersion,
        request_id: command.requestId },
      availableAt: occurredAt, createdAt: occurredAt });
    return this.repository.assign({ ...context, caseId: command.caseId, assignmentId,
      referralSourceId: command.referralSourceId,
      expectedCurrentAssignmentRecordVersion: command.expectedCurrentAssignmentRecordVersion,
      idempotencyKey: command.idempotencyKey,
      requestHash: hashRequestPayload({ case_id: command.caseId,
        expected_current_assignment_record_version: command.expectedCurrentAssignmentRecordVersion,
        referral_source_id: command.referralSourceId }),
      effects: buildAtomicMutationEffects({ audit, outbox }) });
  }
}
function authorize(actor: RequestAccessActor, capability: "cases.read" | "cases.referral_sources.assign"): ActorInput {
  const compatibilityRole = compatibilityRoleForRepository(actor, capability);
  if (!UUID.test(actor.organizationId) || !UUID.test(actor.userId) || !compatibilityRole) forbidden();
  return { organizationId: actor.organizationId, actorUserId: actor.userId,
    actorRole: compatibilityRole };
}
function checkedId(createId: () => string) { const id = createId(); if (!UUID.test(id)) invalid(); return id; }
function invalid(): never { throw new CaseReferralSourceError("CASE_REFERRAL_SOURCE_INVALID"); }
function forbidden(): never { throw new CaseReferralSourceError("CASE_REFERRAL_SOURCE_FORBIDDEN"); }
