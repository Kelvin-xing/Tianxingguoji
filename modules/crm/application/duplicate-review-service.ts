import { randomUUID } from "node:crypto";

import {
  buildAtomicMutationEffects,
  buildAuditEvent,
  buildOutboxMessage,
  type MutationEffectBundle,
} from "../../audit/public.ts";
import { evaluateBootstrapAuthorization } from "../../access/public.ts";
import type { IdentitySessionActor } from "../../identity/public.ts";
import { hashRequestPayload, validateIdempotencyKey } from "../../shared/public.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const DUPLICATE_REVIEW_ENTITY_TYPES = Object.freeze(["student", "guardian"] as const);
export const DUPLICATE_CANDIDATE_STATUSES = Object.freeze(["review_required", "merged"] as const);
export const DUPLICATE_MATCH_SIGNAL_NAMES = Object.freeze([
  "display_name", "date_of_birth", "email", "phone",
] as const);
export const STUDENT_DUPLICATE_FIELDS = Object.freeze([
  "display_name", "date_of_birth", "contact_email", "contact_phone",
] as const);
export const GUARDIAN_DUPLICATE_FIELDS = Object.freeze(["display_name", "email", "phone"] as const);

export type DuplicateReviewEntityType = (typeof DUPLICATE_REVIEW_ENTITY_TYPES)[number];
export type DuplicateCandidateStatus = (typeof DUPLICATE_CANDIDATE_STATUSES)[number];
export type DuplicateMatchSignalName = (typeof DUPLICATE_MATCH_SIGNAL_NAMES)[number];

export interface DuplicateCandidateSummary {
  readonly candidateId: string;
  readonly entityType: DuplicateReviewEntityType;
  readonly leftRecordId: string;
  readonly rightRecordId: string;
  readonly leftDisplayLabel: string;
  readonly rightDisplayLabel: string;
  readonly matchingSignals: readonly DuplicateMatchSignalName[];
  readonly status: DuplicateCandidateStatus;
  readonly mergeId: string | null;
  readonly recordVersion: number;
}

export interface DuplicateRecordSearchItem {
  readonly id: string;
  readonly entityType: DuplicateReviewEntityType;
  readonly displayLabel: string;
  readonly contactHint: string | null;
}

export interface DuplicateProfile {
  readonly id: string;
  readonly entityType: DuplicateReviewEntityType;
  readonly displayName: string;
  readonly dateOfBirth?: string | null;
  readonly contactEmail?: string | null;
  readonly contactPhone?: string | null;
  readonly email?: string | null;
  readonly phone?: string | null;
  readonly recordVersion: number;
}

export interface DuplicateCandidateDetail {
  readonly candidate: DuplicateCandidateSummary;
  readonly leftProfile: DuplicateProfile;
  readonly rightProfile: DuplicateProfile;
  readonly supportedFields: readonly string[];
  readonly merge: DuplicateMergeAcknowledgement | null;
}

export interface DuplicateMergeAcknowledgement {
  readonly id: string;
  readonly sourceRecordId: string;
  readonly canonicalRecordId: string;
  readonly provenanceRevisionId: string;
  readonly status: "active" | "corrected";
  readonly recordVersion: number;
  readonly correctionId: string | null;
}

export interface DuplicateMergeReceipt {
  readonly mergeId: string;
  readonly candidateId: string;
  readonly entityType: DuplicateReviewEntityType;
  readonly sourceRecordId: string;
  readonly canonicalRecordId: string;
  readonly provenanceRevisionId: string;
  readonly recordVersion: number;
}

export interface DuplicateCorrectionAcknowledgement {
  readonly correctiveRevisionId: string;
  readonly mergeId: string;
  readonly sourceRecordId: string;
  readonly canonicalRecordId: string;
  readonly restoredAliasTargetId: string;
  readonly recordVersion: number;
}

export interface DuplicateFieldSelection {
  readonly fieldName: string;
  readonly sourceRecordId: string;
}

interface ActorInput {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly actorRole: IdentitySessionActor["role"];
}

export interface DuplicateReviewRepository {
  searchRecords(input: ActorInput & {
    readonly entityType: DuplicateReviewEntityType;
    readonly query: string;
  }): Promise<readonly DuplicateRecordSearchItem[]>;
  listCandidates(input: ActorInput & {
    readonly entityType: DuplicateReviewEntityType;
    readonly status: DuplicateCandidateStatus;
  }): Promise<readonly DuplicateCandidateSummary[]>;
  findCandidate(input: ActorInput & { readonly candidateId: string }): Promise<DuplicateCandidateDetail | null>;
  createCandidate(input: ActorInput & {
    readonly candidateId: string;
    readonly entityType: DuplicateReviewEntityType;
    readonly leftRecordId: string;
    readonly rightRecordId: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly effects: MutationEffectBundle;
  }): Promise<DuplicateCandidateSummary>;
  mergeCandidate(input: ActorInput & {
    readonly mergeId: string;
    readonly aliasRevisionId: string;
    readonly provenanceRevisionId: string;
    readonly candidateId: string;
    readonly sourceRecordId: string;
    readonly canonicalRecordId: string;
    readonly expectedCandidateRecordVersion: number;
    readonly expectedSourceRecordVersion: number;
    readonly expectedCanonicalRecordVersion: number;
    readonly fieldSelections: readonly DuplicateFieldSelection[];
    readonly reasonCode: "duplicate.confirmed";
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly effects: MutationEffectBundle;
  }): Promise<DuplicateMergeReceipt>;
  correctMerge(input: ActorInput & {
    readonly correctiveRevisionId: string;
    readonly aliasRevisionId: string;
    readonly provenanceRevisionId: string;
    readonly mergeId: string;
    readonly expectedMergeRecordVersion: number;
    readonly reasonCode: "duplicate.merge.corrected";
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly effects: MutationEffectBundle;
  }): Promise<DuplicateCorrectionAcknowledgement>;
}

export type DuplicateReviewErrorCode =
  | "DUPLICATE_REVIEW_FORBIDDEN"
  | "DUPLICATE_REVIEW_INVALID"
  | "DUPLICATE_REVIEW_NOT_FOUND"
  | "DUPLICATE_REVIEW_NO_MATCH"
  | "DUPLICATE_REVIEW_STALE"
  | "DUPLICATE_REVIEW_CONFLICT"
  | "DUPLICATE_REVIEW_UNAVAILABLE";

const ERROR_CODES = new Set<DuplicateReviewErrorCode>([
  "DUPLICATE_REVIEW_FORBIDDEN", "DUPLICATE_REVIEW_INVALID", "DUPLICATE_REVIEW_NOT_FOUND",
  "DUPLICATE_REVIEW_NO_MATCH", "DUPLICATE_REVIEW_STALE", "DUPLICATE_REVIEW_CONFLICT",
  "DUPLICATE_REVIEW_UNAVAILABLE",
]);

export class DuplicateReviewError extends Error {
  readonly code: DuplicateReviewErrorCode;
  constructor(code: DuplicateReviewErrorCode) {
    super(`Duplicate review rejected ${code}.`);
    this.name = "DuplicateReviewError";
    this.code = code;
  }
}

export function isDuplicateReviewError(value: unknown): value is DuplicateReviewError {
  return value instanceof Error && value.name === "DuplicateReviewError" &&
    ERROR_CODES.has((value as Error & { readonly code?: DuplicateReviewErrorCode }).code as DuplicateReviewErrorCode);
}

export class DuplicateReviewService {
  private readonly repository: DuplicateReviewRepository;
  private readonly createId: () => string;
  private readonly now: () => number;

  constructor(
    repository: DuplicateReviewRepository,
    createId: () => string = randomUUID,
    now: () => number = Date.now,
  ) {
    this.repository = repository;
    this.createId = createId;
    this.now = now;
  }

  searchRecords(actor: IdentitySessionActor, entityType: DuplicateReviewEntityType, query: string) {
    authorize(actor, "students.duplicates.review");
    const normalized = query.trim();
    if (!isEntityType(entityType) || normalized.length < 2 || normalized.length > 100) invalid();
    return this.repository.searchRecords(actorInput(actor, { entityType, query: normalized }));
  }

  listCandidates(actor: IdentitySessionActor, entityType: DuplicateReviewEntityType, status: DuplicateCandidateStatus) {
    authorize(actor, "students.duplicates.review");
    if (!isEntityType(entityType) || !isCandidateStatus(status)) invalid();
    return this.repository.listCandidates(actorInput(actor, { entityType, status }));
  }

  findCandidate(actor: IdentitySessionActor, candidateId: string) {
    authorize(actor, "students.duplicates.review");
    requireUuid(candidateId);
    return this.repository.findCandidate(actorInput(actor, { candidateId }));
  }

  createCandidate(input: { readonly actor: IdentitySessionActor; readonly command: {
    readonly entityType: DuplicateReviewEntityType; readonly leftRecordId: string;
    readonly rightRecordId: string; readonly requestId: string; readonly idempotencyKey: string;
  } }) {
    authorize(input.actor, "students.duplicates.review");
    const { command } = input;
    if (!isEntityType(command.entityType) || !REQUEST_ID.test(command.requestId) ||
        command.leftRecordId === command.rightRecordId) invalid();
    requireUuid(command.leftRecordId); requireUuid(command.rightRecordId); requireKey(command.idempotencyKey);
    const candidateId = newId(this.createId);
    return this.repository.createCandidate(actorInput(input.actor, {
      candidateId, entityType: command.entityType, leftRecordId: command.leftRecordId,
      rightRecordId: command.rightRecordId, idempotencyKey: command.idempotencyKey,
      requestHash: hashRequestPayload({ entity_type: command.entityType,
        left_record_id: command.leftRecordId, right_record_id: command.rightRecordId }),
      effects: effects(input.actor, candidateId, command.requestId, "crm.duplicate_candidate_created",
        "create", "duplicate_candidate_created", null, this.createId, this.now),
    }));
  }

  mergeCandidate(input: { readonly actor: IdentitySessionActor; readonly command: {
    readonly candidateId: string; readonly sourceRecordId: string; readonly canonicalRecordId: string;
    readonly expectedCandidateRecordVersion: number; readonly expectedSourceRecordVersion: number;
    readonly expectedCanonicalRecordVersion: number; readonly fieldSelections: readonly DuplicateFieldSelection[];
    readonly reasonCode: "duplicate.confirmed"; readonly requestId: string; readonly idempotencyKey: string;
  } }) {
    authorize(input.actor, "students.duplicates.merge");
    const { command } = input;
    [command.candidateId, command.sourceRecordId, command.canonicalRecordId].forEach(requireUuid);
    if (command.sourceRecordId === command.canonicalRecordId || command.reasonCode !== "duplicate.confirmed" ||
        !validVersion(command.expectedCandidateRecordVersion) || !validVersion(command.expectedSourceRecordVersion) ||
        !validVersion(command.expectedCanonicalRecordVersion) || !REQUEST_ID.test(command.requestId) ||
        !Array.isArray(command.fieldSelections)) invalid();
    requireKey(command.idempotencyKey);
    const selections = Object.freeze(command.fieldSelections.map((selection) => Object.freeze({ ...selection })));
    const mergeId = newId(this.createId); const aliasRevisionId = newId(this.createId);
    const provenanceRevisionId = newId(this.createId);
    return this.repository.mergeCandidate(actorInput(input.actor, {
      mergeId, aliasRevisionId, provenanceRevisionId, ...command, fieldSelections: selections,
      requestHash: hashRequestPayload({ candidate_id: command.candidateId,
        canonical_record_id: command.canonicalRecordId,
        expected_candidate_record_version: command.expectedCandidateRecordVersion,
        expected_canonical_record_version: command.expectedCanonicalRecordVersion,
        expected_source_record_version: command.expectedSourceRecordVersion,
        field_selections: selections.map((item) => ({ field_name: item.fieldName,
          source_record_id: item.sourceRecordId })), reason_code: command.reasonCode,
        source_record_id: command.sourceRecordId }),
      effects: effects(input.actor, mergeId, command.requestId, "crm.duplicate_merge_approved",
        "merge", "duplicate_merge_approved", command.reasonCode, this.createId, this.now),
    }));
  }

  correctMerge(input: { readonly actor: IdentitySessionActor; readonly command: {
    readonly mergeId: string; readonly expectedMergeRecordVersion: number;
    readonly reasonCode: "duplicate.merge.corrected"; readonly requestId: string;
    readonly idempotencyKey: string;
  } }) {
    authorize(input.actor, "students.duplicates.merge");
    const { command } = input; requireUuid(command.mergeId); requireKey(command.idempotencyKey);
    if (!validVersion(command.expectedMergeRecordVersion) || command.reasonCode !== "duplicate.merge.corrected" ||
        !REQUEST_ID.test(command.requestId)) invalid();
    const correctiveRevisionId = newId(this.createId); const aliasRevisionId = newId(this.createId);
    const provenanceRevisionId = newId(this.createId);
    return this.repository.correctMerge(actorInput(input.actor, {
      correctiveRevisionId, aliasRevisionId, provenanceRevisionId, ...command,
      requestHash: hashRequestPayload({ expected_merge_record_version: command.expectedMergeRecordVersion,
        merge_id: command.mergeId, reason_code: command.reasonCode }),
      effects: effects(input.actor, correctiveRevisionId, command.requestId,
        "crm.duplicate_merge_corrected", "correct", "duplicate_merge_corrected", command.reasonCode,
        this.createId, this.now),
    }));
  }
}

function actorInput<T extends object>(actor: IdentitySessionActor, extra: T): ActorInput & T {
  return { organizationId: actor.organizationId, actorUserId: actor.userId, actorRole: actor.role, ...extra };
}
function authorize(actor: IdentitySessionActor, capability: "students.duplicates.review" | "students.duplicates.merge") {
  if (!UUID.test(actor.organizationId) || !UUID.test(actor.userId) ||
      !evaluateBootstrapAuthorization(actor.role, { capability }).allowed) {
    throw new DuplicateReviewError("DUPLICATE_REVIEW_FORBIDDEN");
  }
}
function isEntityType(value: unknown): value is DuplicateReviewEntityType {
  return (DUPLICATE_REVIEW_ENTITY_TYPES as readonly unknown[]).includes(value);
}
function isCandidateStatus(value: unknown): value is DuplicateCandidateStatus {
  return (DUPLICATE_CANDIDATE_STATUSES as readonly unknown[]).includes(value);
}
function requireUuid(value: string) { if (!UUID.test(value)) invalid(); }
function requireKey(value: string) { try { validateIdempotencyKey(value); } catch { invalid(); } }
function validVersion(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 1; }
function invalid(): never { throw new DuplicateReviewError("DUPLICATE_REVIEW_INVALID"); }
function newId(createId: () => string): string { const id = createId(); requireUuid(id); return id; }
function effects(actor: IdentitySessionActor, resourceId: string, requestId: string, eventType: string,
  action: string, effectType: string, reasonCode: string | null, createId: () => string,
  now: () => number): MutationEffectBundle {
  const occurredAt = new Date(now()).toISOString();
  const audit = buildAuditEvent({ id: newId(createId), organizationId: actor.organizationId,
    actorUserId: actor.userId, actorKind: "user", eventType, eventVersion: 1, action,
    resourceType: "CrmDuplicateReview", resourceId, outcome: "succeeded", requestId, occurredAt,
    metadata: { effect_type: effectType, ...(reasonCode ? { reason_code: reasonCode } : {}) } });
  const outbox = buildOutboxMessage({ id: newId(createId), auditEventId: audit.id,
    organizationId: actor.organizationId, aggregateType: "CrmDuplicateReview", aggregateId: resourceId,
    eventType, eventVersion: 1, idempotencyKey: `${effectType}-${audit.id}`, requestId,
    payload: { aggregate_id: resourceId, effect_type: effectType, operation: action,
      request_id: requestId, status: "pending", ...(reasonCode ? { reason_code: reasonCode } : {}) },
    availableAt: occurredAt, createdAt: occurredAt });
  return buildAtomicMutationEffects({ audit, outbox });
}
