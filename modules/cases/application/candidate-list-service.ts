import { createHash, randomUUID } from "node:crypto";

import {
  hasRequestCapability,
  type RequestAccessActor,
} from "../../access/public.ts";
import {
  buildAtomicMutationEffects,
  buildAuditEvent,
  buildOutboxMessage,
  type MutationEffectBundle,
} from "../../audit/public.ts";
import { hashRequestPayload, validateIdempotencyKey } from "../../shared/public.ts";
import type {
  FounderListDecision,
  GuardianConfirmationChannel,
  GuardianListDecision,
} from "../domain/candidate-list-case-flow.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface CandidateListItemInput {
  readonly id: string;
  readonly schoolId: string;
  readonly pinnedResolvedRevisionId: string;
  readonly pinnedResolutionSha256: string;
  readonly ordinal: number;
}

export interface CandidateListAcknowledgement {
  readonly id: string;
  readonly recordVersion: number;
  readonly caseRecordVersion?: number;
  readonly founderDecisionSha256?: string;
}

interface CandidateListRepositoryBase {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly idempotencyRecordId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly occurredAt: string;
  readonly effects: MutationEffectBundle;
}

export interface CandidateListRepository {
  createVersion(input: CandidateListRepositoryBase & {
    readonly caseId: string;
    readonly versionId: string;
    readonly previousVersionId: string | null;
    readonly expectedCaseRecordVersion: number;
    readonly schoolSetSha256: string;
    readonly changeSummary: string;
    readonly items: readonly CandidateListItemInput[];
  }): Promise<CandidateListAcknowledgement>;
  reviewVersion(input: CandidateListRepositoryBase & {
    readonly caseId: string;
    readonly versionId: string;
    readonly expectedRecordVersion: number;
    readonly decision: FounderListDecision;
    readonly reason: string;
  }): Promise<CandidateListAcknowledgement>;
  recordGuardianDecision(input: CandidateListRepositoryBase & {
    readonly caseId: string;
    readonly versionId: string;
    readonly expectedListRecordVersion: number;
    readonly expectedCaseRecordVersion: number;
    readonly guardianId: string;
    readonly guardianRelationshipId: string;
    readonly decision: GuardianListDecision;
    readonly channel: GuardianConfirmationChannel;
    readonly guardianDecidedAt: string;
    readonly boundFounderDecisionSha256: string;
    readonly transitionFactId: string;
  }): Promise<CandidateListAcknowledgement>;
  closeCase(input: CandidateListRepositoryBase & {
    readonly caseId: string;
    readonly expectedCaseRecordVersion: number;
    readonly closureOutcome: "success" | "no_offer" | "service_terminated";
    readonly reason: string;
    readonly transitionFactId: string;
    readonly lifecycleFactId: string;
  }): Promise<CandidateListAcknowledgement>;
}

export type CandidateListErrorCode =
  | "CANDIDATE_LIST_INVALID"
  | "CANDIDATE_LIST_FORBIDDEN"
  | "CANDIDATE_LIST_NOT_FOUND"
  | "CANDIDATE_LIST_STALE_VERSION"
  | "CANDIDATE_LIST_CASE_NOT_ACTIVE"
  | "CANDIDATE_LIST_BACKGROUND_INCOMPLETE"
  | "CANDIDATE_LIST_SELECTION_BLOCKED"
  | "CANDIDATE_LIST_GUARDIAN_INVALID"
  | "CANDIDATE_LIST_IDEMPOTENCY_KEY_REUSED"
  | "CANDIDATE_LIST_IDEMPOTENCY_IN_PROGRESS"
  | "CANDIDATE_LIST_CONFLICT"
  | "CASE_CLOSE_INVALID"
  | "CASE_CLOSE_NOT_FOUND"
  | "CASE_CLOSE_STALE_VERSION"
  | "CASE_CLOSE_TARGETS_INCOMPLETE"
  | "CASE_CLOSE_TASKS_INCOMPLETE";

const ERROR_CODES = new Set<CandidateListErrorCode>([
  "CANDIDATE_LIST_INVALID", "CANDIDATE_LIST_FORBIDDEN", "CANDIDATE_LIST_NOT_FOUND",
  "CANDIDATE_LIST_STALE_VERSION", "CANDIDATE_LIST_CASE_NOT_ACTIVE",
  "CANDIDATE_LIST_BACKGROUND_INCOMPLETE", "CANDIDATE_LIST_SELECTION_BLOCKED",
  "CANDIDATE_LIST_GUARDIAN_INVALID", "CANDIDATE_LIST_IDEMPOTENCY_KEY_REUSED",
  "CANDIDATE_LIST_IDEMPOTENCY_IN_PROGRESS", "CANDIDATE_LIST_CONFLICT",
  "CASE_CLOSE_INVALID", "CASE_CLOSE_NOT_FOUND", "CASE_CLOSE_STALE_VERSION",
  "CASE_CLOSE_TARGETS_INCOMPLETE", "CASE_CLOSE_TASKS_INCOMPLETE",
]);

export class CandidateListError extends Error {
  readonly code: CandidateListErrorCode;
  constructor(code: CandidateListErrorCode) {
    super(`Candidate list command rejected ${code}.`);
    this.name = "CandidateListError";
    this.code = code;
  }
}

export function isCandidateListError(value: unknown): value is CandidateListError {
  if (!(value instanceof Error) || value.name !== "CandidateListError") return false;
  return ERROR_CODES.has((value as CandidateListError).code);
}

export class CandidateListService {
  private readonly repository: CandidateListRepository;
  private readonly createId: () => string;
  private readonly now: () => number;

  constructor(
    repository: CandidateListRepository,
    createId: () => string = randomUUID,
    now: () => number = Date.now,
  ) {
    this.repository = repository;
    this.createId = createId;
    this.now = now;
  }

  createVersion(input: Readonly<{
    actor: RequestAccessActor;
    caseId: string;
    previousVersionId: string | null;
    expectedCaseRecordVersion: number;
    changeSummary: string;
    items: readonly Omit<CandidateListItemInput, "id">[];
    requestId: string;
    idempotencyKey: string;
  }>): Promise<CandidateListAcknowledgement> {
    authorize(input.actor, "advisor");
    assertCommon(input.caseId, input.expectedCaseRecordVersion, input.requestId,
      input.idempotencyKey);
    if ((input.previousVersionId !== null && !UUID.test(input.previousVersionId)) ||
        input.changeSummary.trim().length < 1 || input.changeSummary.trim().length > 1000 ||
        input.items.length < 1 || input.items.length > 50) invalid();
    const items = input.items.map((item) => Object.freeze({ ...validateItem(item), id: checkedId(this.createId) }));
    assertItemsUniqueAndContiguous(items);
    const versionId = checkedId(this.createId);
    const occurredAt = checkedTime(this.now);
    const schoolSetSha256 = hashCandidateSchoolSet(items);
    const requestHash = hashRequestPayload({
      case_id: input.caseId, change_summary: input.changeSummary.trim(),
      expected_case_record_version: input.expectedCaseRecordVersion,
      items: items.map(({ id: _id, ...item }) => ({
        ordinal: item.ordinal, pinned_resolution_sha256: item.pinnedResolutionSha256,
        pinned_resolved_revision_id: item.pinnedResolvedRevisionId, school_id: item.schoolId,
      })), previous_version_id: input.previousVersionId,
    });
    return this.repository.createVersion({
      ...baseMutation(input.actor, input.idempotencyKey, input.requestId, requestHash,
        occurredAt, versionId, "cases.candidate_list_submitted", "submit", 2, this.createId),
      caseId: input.caseId, versionId, previousVersionId: input.previousVersionId,
      expectedCaseRecordVersion: input.expectedCaseRecordVersion,
      schoolSetSha256, changeSummary: input.changeSummary.trim(), items,
    });
  }

  reviewVersion(input: Readonly<{
    actor: RequestAccessActor;
    caseId: string;
    versionId: string;
    expectedRecordVersion: number;
    decision: FounderListDecision;
    reason: string;
    requestId: string;
    idempotencyKey: string;
  }>): Promise<CandidateListAcknowledgement> {
    authorize(input.actor, "founder");
    assertCommon(input.caseId, input.expectedRecordVersion, input.requestId, input.idempotencyKey);
    if (!UUID.test(input.versionId) || !["approved", "rejected"].includes(input.decision) ||
        input.reason.trim().length < 1 || input.reason.trim().length > 1000) invalid();
    const occurredAt = checkedTime(this.now);
    const requestHash = hashRequestPayload({ case_id: input.caseId, decision: input.decision,
      expected_record_version: input.expectedRecordVersion, reason: input.reason.trim(),
      version_id: input.versionId });
    return this.repository.reviewVersion({
      ...baseMutation(input.actor, input.idempotencyKey, input.requestId, requestHash,
        occurredAt, input.versionId, `cases.candidate_list_${input.decision}`, "review",
        input.expectedRecordVersion + 1, this.createId),
      caseId: input.caseId, versionId: input.versionId,
      expectedRecordVersion: input.expectedRecordVersion, decision: input.decision,
      reason: input.reason.trim(),
    });
  }

  recordGuardianDecision(input: Readonly<{
    actor: RequestAccessActor;
    caseId: string;
    versionId: string;
    expectedListRecordVersion: number;
    expectedCaseRecordVersion: number;
    guardianId: string;
    guardianRelationshipId: string;
    decision: GuardianListDecision;
    channel: GuardianConfirmationChannel;
    guardianDecidedAt: string;
    boundFounderDecisionSha256: string;
    requestId: string;
    idempotencyKey: string;
  }>): Promise<CandidateListAcknowledgement> {
    authorize(input.actor, "advisor");
    assertCommon(input.caseId, input.expectedListRecordVersion, input.requestId,
      input.idempotencyKey);
    if (!UUID.test(input.versionId) || !UUID.test(input.guardianId) ||
        !UUID.test(input.guardianRelationshipId) ||
        !Number.isSafeInteger(input.expectedCaseRecordVersion) || input.expectedCaseRecordVersion < 1 ||
        !["confirmed", "not_confirmed"].includes(input.decision) ||
        !["phone", "wechat", "in_person"].includes(input.channel) ||
        !SHA256.test(input.boundFounderDecisionSha256) ||
        !Number.isFinite(Date.parse(input.guardianDecidedAt))) invalid();
    const occurredAt = checkedTime(this.now);
    if (Date.parse(input.guardianDecidedAt) > Date.parse(occurredAt)) invalid();
    const requestHash = hashRequestPayload({
      bound_founder_decision_sha256: input.boundFounderDecisionSha256,
      case_id: input.caseId, channel: input.channel, decision: input.decision,
      expected_case_record_version: input.expectedCaseRecordVersion,
      expected_list_record_version: input.expectedListRecordVersion,
      guardian_decided_at: input.guardianDecidedAt, guardian_id: input.guardianId,
      guardian_relationship_id: input.guardianRelationshipId, version_id: input.versionId,
    });
    return this.repository.recordGuardianDecision({
      ...baseMutation(input.actor, input.idempotencyKey, input.requestId, requestHash,
        occurredAt, input.versionId, `cases.candidate_list_guardian_${input.decision}`,
        "confirm", input.expectedListRecordVersion + 1, this.createId),
      caseId: input.caseId, versionId: input.versionId,
      expectedListRecordVersion: input.expectedListRecordVersion,
      expectedCaseRecordVersion: input.expectedCaseRecordVersion,
      guardianId: input.guardianId, guardianRelationshipId: input.guardianRelationshipId,
      decision: input.decision, channel: input.channel,
      guardianDecidedAt: input.guardianDecidedAt,
      boundFounderDecisionSha256: input.boundFounderDecisionSha256,
      transitionFactId: checkedId(this.createId),
    });
  }

  closeCase(input: Readonly<{
    actor: RequestAccessActor;
    caseId: string;
    expectedCaseRecordVersion: number;
    closureOutcome: "success" | "no_offer" | "service_terminated";
    reason: string;
    requestId: string;
    idempotencyKey: string;
  }>): Promise<CandidateListAcknowledgement> {
    authorize(input.actor,"founder");
    assertCommon(input.caseId,input.expectedCaseRecordVersion,input.requestId,input.idempotencyKey);
    if (!["success","no_offer","service_terminated"].includes(input.closureOutcome) ||
        input.reason.trim().length < 1 || input.reason.trim().length > 900) invalid();
    const occurredAt = checkedTime(this.now);
    const requestHash = hashRequestPayload({ case_id: input.caseId,
      closure_outcome: input.closureOutcome,
      expected_case_record_version: input.expectedCaseRecordVersion,
      reason: input.reason.trim() });
    return this.repository.closeCase({
      ...baseMutation(input.actor,input.idempotencyKey,input.requestId,requestHash,
        occurredAt,input.caseId,"cases.service_case_closed","close",
        input.expectedCaseRecordVersion + 1,this.createId),
      caseId: input.caseId,expectedCaseRecordVersion: input.expectedCaseRecordVersion,
      closureOutcome: input.closureOutcome,reason: input.reason.trim(),
      transitionFactId: checkedId(this.createId),lifecycleFactId: checkedId(this.createId),
    });
  }
}

export function hashCandidateSchoolSet(items: readonly Pick<CandidateListItemInput,
  "ordinal" | "schoolId" | "pinnedResolvedRevisionId" | "pinnedResolutionSha256">[]): string {
  const canonical = [...items].sort((a, b) => a.ordinal - b.ordinal).map((item) =>
    `${item.ordinal}:${item.schoolId}:${item.pinnedResolvedRevisionId}:${item.pinnedResolutionSha256}`,
  ).join("|");
  return createHash("sha256").update(canonical).digest("hex");
}

function authorize(actor: RequestAccessActor, requiredRole: "founder" | "advisor"): void {
  if (!UUID.test(actor.organizationId) || !UUID.test(actor.userId) ||
      !hasRequestCapability(actor, "cases.workflow.manage") ||
      actor.roles?.includes(requiredRole) !== true) forbidden();
}
function assertCommon(caseId: string, version: number, requestId: string, key: string): void {
  if (!UUID.test(caseId) || !Number.isSafeInteger(version) || version < 1 ||
      !REQUEST_ID.test(requestId)) invalid();
  try { validateIdempotencyKey(key); } catch { invalid(); }
}
function validateItem(item: Omit<CandidateListItemInput, "id">) {
  if (!UUID.test(item.schoolId) || !UUID.test(item.pinnedResolvedRevisionId) ||
      !SHA256.test(item.pinnedResolutionSha256) || !Number.isSafeInteger(item.ordinal) ||
      item.ordinal < 1) invalid();
  return item;
}
function assertItemsUniqueAndContiguous(items: readonly CandidateListItemInput[]): void {
  const schools = new Set(items.map((item) => item.schoolId));
  const ordinals = [...items].map((item) => item.ordinal).sort((a, b) => a - b);
  if (schools.size !== items.length || ordinals.some((value, index) => value !== index + 1)) invalid();
}
function baseMutation(actor: RequestAccessActor, idempotencyKey: string, requestId: string,
  requestHash: string, occurredAt: string, resourceId: string, eventType: string,
  action: string, resultRecordVersion: number,
  createId: () => string): CandidateListRepositoryBase {
  const resourceType = eventType === "cases.service_case_closed"
    ? "ServiceCase" : "CandidateSchoolListVersion";
  const auditId = checkedId(createId);
  const audit = buildAuditEvent({ id: auditId, organizationId: actor.organizationId,
    actorUserId: actor.userId, actorKind: "user", eventType, eventVersion: 1, action,
    resourceType, resourceId, outcome: "succeeded",
    requestId, occurredAt, metadata: { effect_type: eventType,
      record_version: resultRecordVersion } });
  const outbox = buildOutboxMessage({ id: checkedId(createId), auditEventId: auditId,
    organizationId: actor.organizationId, aggregateType: resourceType,
    aggregateId: resourceId, eventType, eventVersion: 1,
    idempotencyKey: `candidate-list-${auditId}`, requestId,
    payload: { aggregate_id: resourceId, effect_type: eventType,
      operation: "cases.candidate_list", record_version: resultRecordVersion,
      request_id: requestId },
    availableAt: occurredAt, createdAt: occurredAt });
  return { organizationId: actor.organizationId, actorUserId: actor.userId,
    idempotencyRecordId: checkedId(createId), idempotencyKey, requestHash, occurredAt,
    effects: buildAtomicMutationEffects({ audit, outbox }) };
}
function checkedId(createId: () => string): string { const id = createId(); if (!UUID.test(id)) invalid(); return id; }
function checkedTime(now: () => number): string { const value = now(); if (!Number.isSafeInteger(value) || value <= 0) invalid(); return new Date(value).toISOString(); }
function invalid(): never { throw new CandidateListError("CANDIDATE_LIST_INVALID"); }
function forbidden(): never { throw new CandidateListError("CANDIDATE_LIST_FORBIDDEN"); }
