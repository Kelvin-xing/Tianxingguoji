import { randomUUID } from "node:crypto";

import {
  buildAtomicMutationEffects,
  buildAuditEvent,
  buildOutboxMessage,
  type MutationEffectBundle,
} from "../../audit/public.ts";
import type { IdentitySessionActor } from "../../identity/public.ts";
import { hashRequestPayload, validateIdempotencyKey } from "../../shared/public.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_CODE = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;

export const DUPLICATE_ENTITY_TYPES = Object.freeze(["student", "guardian", "school"] as const);
export const DUPLICATE_MATCH_SIGNALS = Object.freeze([
  "display_name",
  "date_of_birth",
  "email",
  "phone",
  "official_website",
  "source_key",
] as const);

export type DuplicateEntityType = (typeof DUPLICATE_ENTITY_TYPES)[number];
export type DuplicateMatchSignal = (typeof DUPLICATE_MATCH_SIGNALS)[number];

export interface DuplicateMergeClock {
  nowMs(): number;
}

export interface CreateDuplicateCandidateCommand {
  readonly entityType: DuplicateEntityType;
  readonly leftRecordId: string;
  readonly rightRecordId: string;
  readonly matchingSignals: readonly DuplicateMatchSignal[];
  readonly requestId: string;
  readonly idempotencyKey: string;
}

export interface MergeFieldSelection {
  /** The selected record is preserved as the value provenance for this field. */
  readonly fieldName: string;
  readonly sourceRecordId: string;
}

export interface MergeDuplicateCandidateCommand {
  readonly candidateId: string;
  readonly entityType: DuplicateEntityType;
  readonly sourceRecordId: string;
  readonly canonicalRecordId: string;
  readonly expectedCandidateRecordVersion: number;
  readonly expectedSourceRecordVersion: number;
  readonly expectedCanonicalRecordVersion: number;
  readonly fieldSelections: readonly MergeFieldSelection[];
  readonly reasonCode: string;
  readonly requestId: string;
  readonly idempotencyKey: string;
}

export interface CorrectDuplicateMergeCommand {
  readonly mergeId: string;
  readonly expectedMergeRecordVersion: number;
  readonly reasonCode: string;
  readonly requestId: string;
  readonly idempotencyKey: string;
}

export interface DuplicateCandidateResult {
  readonly candidateId: string;
  readonly entityType: DuplicateEntityType;
  readonly leftRecordId: string;
  readonly rightRecordId: string;
  /** Versions captured by the candidate transaction for a later merge check. */
  readonly leftRecordVersion: number;
  readonly rightRecordVersion: number;
  readonly matchingSignals: readonly DuplicateMatchSignal[];
  readonly status: "review_required";
  readonly recordVersion: number;
}

export interface DuplicateMergeResult {
  readonly mergeId: string;
  readonly candidateId: string;
  readonly entityType: DuplicateEntityType;
  readonly sourceRecordId: string;
  readonly canonicalRecordId: string;
  readonly fieldProvenanceRevisionId: string;
  readonly recordVersion: number;
}

export interface DuplicateMergeUndoResult {
  readonly correctiveRevisionId: string;
  readonly mergeId: string;
  readonly entityType: DuplicateEntityType;
  readonly sourceRecordId: string;
  readonly canonicalRecordId: string;
  readonly restoredAliasTargetId: string;
  readonly recordVersion: number;
}

/**
 * The RDS adapter is the enforcement owner for the complete transaction. It
 * must re-authorize reads rather than trusting the caller or service layer.
 */
export interface DuplicateMergeRepository {
  /**
   * In one transaction: authorize candidate visibility, lock/verify both
   * records are current and same-entity, create a review-only candidate, and
   * persist idempotency/audit/outbox. This operation must not create aliases.
   */
  createCandidate(input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly candidateId: string;
    readonly entityType: DuplicateEntityType;
    readonly leftRecordId: string;
    readonly rightRecordId: string;
    readonly matchingSignals: readonly DuplicateMatchSignal[];
    readonly requestId: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly createdAtMs: number;
    readonly effects: MutationEffectBundle;
  }): Promise<DuplicateCandidateResult>;

  /**
   * In one transaction: authorize Founder approval, lock the candidate and
   * both records, compare all supplied versions, verify pair/entity/alias
   * state, append alias + field-provenance revisions, and persist the merge,
   * idempotency, audit, and outbox. Source records must never be deleted.
   */
  mergeCandidate(input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly mergeId: string;
    readonly fieldProvenanceRevisionId: string;
    readonly candidateId: string;
    readonly entityType: DuplicateEntityType;
    readonly sourceRecordId: string;
    readonly canonicalRecordId: string;
    readonly expectedCandidateRecordVersion: number;
    readonly expectedSourceRecordVersion: number;
    readonly expectedCanonicalRecordVersion: number;
    readonly fieldSelections: readonly MergeFieldSelection[];
    readonly reasonCode: string;
    readonly requestId: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly mergedAtMs: number;
    readonly effects: MutationEffectBundle;
  }): Promise<DuplicateMergeResult>;

  /**
   * In one transaction: authorize Founder approval, lock the active merge and
   * alias, compare its version, append a corrective alias/provenance revision
   * that resolves the source to itself, and persist idempotency/audit/outbox.
   * The original merge and its aliases/provenance remain immutable history.
   */
  undoMerge(input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly correctiveRevisionId: string;
    readonly mergeId: string;
    readonly expectedMergeRecordVersion: number;
    readonly reasonCode: string;
    readonly requestId: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly correctedAtMs: number;
    readonly effects: MutationEffectBundle;
  }): Promise<DuplicateMergeUndoResult>;
}

export type DuplicateMergeErrorCode =
  | "DUPLICATE_MERGE_COMMAND_INVALID"
  | "DUPLICATE_MERGE_CANDIDATE_ACTOR_REQUIRED"
  | "DUPLICATE_MERGE_FOUNDER_REQUIRED"
  | "DUPLICATE_MERGE_CANDIDATE_NOT_FOUND"
  | "DUPLICATE_MERGE_RECORD_NOT_FOUND"
  | "DUPLICATE_MERGE_NOT_FOUND"
  | "DUPLICATE_MERGE_CANDIDATE_STALE"
  | "DUPLICATE_MERGE_RECORD_STALE"
  | "DUPLICATE_MERGE_STALE"
  | "DUPLICATE_MERGE_CANDIDATE_PAIR_MISMATCH"
  | "DUPLICATE_MERGE_ALREADY_APPLIED"
  | "DUPLICATE_MERGE_NOT_ACTIVE"
  | "DUPLICATE_MERGE_IDEMPOTENCY_KEY_REUSED"
  | "DUPLICATE_MERGE_IDEMPOTENCY_IN_PROGRESS";

export class DuplicateMergeError extends Error {
  readonly code: DuplicateMergeErrorCode;

  constructor(code: DuplicateMergeErrorCode) {
    super(`Duplicate merge rejected ${code}.`);
    this.name = "DuplicateMergeError";
    this.code = code;
  }
}

export interface DuplicateMergeServiceOptions {
  readonly repository: DuplicateMergeRepository;
  readonly clock?: DuplicateMergeClock;
  readonly createId?: () => string;
}

export class DuplicateMergeService {
  private readonly repository: DuplicateMergeRepository;
  private readonly clock: DuplicateMergeClock;
  private readonly createId: () => string;

  constructor(options: DuplicateMergeServiceOptions) {
    this.repository = options.repository;
    this.clock = options.clock ?? { nowMs: () => Date.now() };
    this.createId = options.createId ?? randomUUID;
  }

  async createCandidate(input: {
    readonly actor: IdentitySessionActor;
    readonly command: CreateDuplicateCandidateCommand;
  }): Promise<DuplicateCandidateResult> {
    assertCandidateActor(input.actor);
    const command = normalizeCandidateCommand(input.command);
    const candidateId = this.createValidId();
    const auditId = this.createValidId();
    const outboxId = this.createValidId();
    const createdAtMs = validNow(this.clock.nowMs());
    const occurredAt = new Date(createdAtMs).toISOString();
    const eventType = "crm.duplicate_candidate_created";
    const effects = effectsFor({
      auditId,
      outboxId,
      organizationId: input.actor.organizationId,
      actorUserId: input.actor.userId,
      eventType,
      action: "create",
      resourceType: "DuplicateCandidate",
      resourceId: candidateId,
      requestId: command.requestId,
      occurredAt,
      effectType: "duplicate_candidate_created",
      reasonCode: null,
    });

    return this.repository.createCandidate({
      organizationId: input.actor.organizationId,
      actorUserId: input.actor.userId,
      candidateId,
      entityType: command.entityType,
      leftRecordId: command.leftRecordId,
      rightRecordId: command.rightRecordId,
      matchingSignals: command.matchingSignals,
      requestId: command.requestId,
      idempotencyKey: command.idempotencyKey,
      requestHash: hashRequestPayload({
        entityType: command.entityType,
        leftRecordId: command.leftRecordId,
        matchingSignals: command.matchingSignals,
        rightRecordId: command.rightRecordId,
      }),
      createdAtMs,
      effects,
    });
  }

  async mergeCandidate(input: {
    readonly actor: IdentitySessionActor;
    readonly command: MergeDuplicateCandidateCommand;
  }): Promise<DuplicateMergeResult> {
    assertFounder(input.actor);
    const command = normalizeMergeCommand(input.command);
    const mergeId = this.createValidId();
    const fieldProvenanceRevisionId = this.createValidId();
    const auditId = this.createValidId();
    const outboxId = this.createValidId();
    const mergedAtMs = validNow(this.clock.nowMs());
    const occurredAt = new Date(mergedAtMs).toISOString();
    const eventType = "crm.duplicate_merge_approved";
    const effects = effectsFor({
      auditId,
      outboxId,
      organizationId: input.actor.organizationId,
      actorUserId: input.actor.userId,
      eventType,
      action: "merge",
      resourceType: "DuplicateMerge",
      resourceId: mergeId,
      requestId: command.requestId,
      occurredAt,
      effectType: "duplicate_merge_approved",
      reasonCode: command.reasonCode,
    });

    return this.repository.mergeCandidate({
      organizationId: input.actor.organizationId,
      actorUserId: input.actor.userId,
      mergeId,
      fieldProvenanceRevisionId,
      candidateId: command.candidateId,
      entityType: command.entityType,
      sourceRecordId: command.sourceRecordId,
      canonicalRecordId: command.canonicalRecordId,
      expectedCandidateRecordVersion: command.expectedCandidateRecordVersion,
      expectedSourceRecordVersion: command.expectedSourceRecordVersion,
      expectedCanonicalRecordVersion: command.expectedCanonicalRecordVersion,
      fieldSelections: command.fieldSelections,
      reasonCode: command.reasonCode,
      requestId: command.requestId,
      idempotencyKey: command.idempotencyKey,
      requestHash: hashRequestPayload({
        candidateId: command.candidateId,
        canonicalRecordId: command.canonicalRecordId,
        entityType: command.entityType,
        expectedCandidateRecordVersion: command.expectedCandidateRecordVersion,
        expectedCanonicalRecordVersion: command.expectedCanonicalRecordVersion,
        expectedSourceRecordVersion: command.expectedSourceRecordVersion,
        fieldSelections: command.fieldSelections.map((selection) => ({
          fieldName: selection.fieldName,
          sourceRecordId: selection.sourceRecordId,
        })),
        reasonCode: command.reasonCode,
        sourceRecordId: command.sourceRecordId,
      }),
      mergedAtMs,
      effects,
    });
  }

  async undoMerge(input: {
    readonly actor: IdentitySessionActor;
    readonly command: CorrectDuplicateMergeCommand;
  }): Promise<DuplicateMergeUndoResult> {
    assertFounder(input.actor);
    const command = normalizeUndoCommand(input.command);
    const correctiveRevisionId = this.createValidId();
    const auditId = this.createValidId();
    const outboxId = this.createValidId();
    const correctedAtMs = validNow(this.clock.nowMs());
    const occurredAt = new Date(correctedAtMs).toISOString();
    const eventType = "crm.duplicate_merge_corrected";
    const effects = effectsFor({
      auditId,
      outboxId,
      organizationId: input.actor.organizationId,
      actorUserId: input.actor.userId,
      eventType,
      action: "correct",
      resourceType: "DuplicateMergeCorrection",
      resourceId: correctiveRevisionId,
      requestId: command.requestId,
      occurredAt,
      effectType: "duplicate_merge_corrected",
      reasonCode: command.reasonCode,
    });

    return this.repository.undoMerge({
      organizationId: input.actor.organizationId,
      actorUserId: input.actor.userId,
      correctiveRevisionId,
      mergeId: command.mergeId,
      expectedMergeRecordVersion: command.expectedMergeRecordVersion,
      reasonCode: command.reasonCode,
      requestId: command.requestId,
      idempotencyKey: command.idempotencyKey,
      requestHash: hashRequestPayload({
        expectedMergeRecordVersion: command.expectedMergeRecordVersion,
        mergeId: command.mergeId,
        reasonCode: command.reasonCode,
      }),
      correctedAtMs,
      effects,
    });
  }

  private createValidId(): string {
    const id = this.createId();
    if (!UUID.test(id)) throw new DuplicateMergeError("DUPLICATE_MERGE_COMMAND_INVALID");
    return id;
  }
}

export interface DuplicateMergeRuntime {
  readonly service: DuplicateMergeService;
}

export class DuplicateMergeRuntimeUnavailable extends Error {
  constructor() {
    super("Duplicate merge runtime is not configured.");
    this.name = "DuplicateMergeRuntimeUnavailable";
  }
}

/**
 * There is intentionally no local, mock, JSON, legacy-Neon, or partial-write
 * runtime. Production must install one HK RDS adapter for the full transaction.
 */
export function getDuplicateMergeRuntime(): DuplicateMergeRuntime {
  throw new DuplicateMergeRuntimeUnavailable();
}

function assertCandidateActor(actor: IdentitySessionActor): void {
  if (
    !UUID.test(actor.organizationId) ||
    !UUID.test(actor.userId) ||
    actor.role !== "founder" &&
    actor.role !== "advisor" &&
    actor.role !== "data_reviewer"
  ) {
    throw new DuplicateMergeError("DUPLICATE_MERGE_CANDIDATE_ACTOR_REQUIRED");
  }
}

function assertFounder(actor: IdentitySessionActor): void {
  if (!UUID.test(actor.organizationId) || !UUID.test(actor.userId) || actor.role !== "founder") {
    throw new DuplicateMergeError("DUPLICATE_MERGE_FOUNDER_REQUIRED");
  }
}

function normalizeCandidateCommand(
  command: CreateDuplicateCandidateCommand,
): Readonly<CreateDuplicateCandidateCommand> {
  if (
    !isEntityType(command.entityType) ||
    !UUID.test(command.leftRecordId) ||
    !UUID.test(command.rightRecordId) ||
    command.leftRecordId === command.rightRecordId ||
    !SAFE_CODE.test(command.requestId)
  ) {
    throw new DuplicateMergeError("DUPLICATE_MERGE_COMMAND_INVALID");
  }
  validateIdempotency(command.idempotencyKey);
  const signals = normalizeSignals(command.entityType, command.matchingSignals);
  return Object.freeze({
    ...command,
    matchingSignals: signals,
    requestId: command.requestId.trim(),
  });
}

function normalizeMergeCommand(
  command: MergeDuplicateCandidateCommand,
): Readonly<MergeDuplicateCandidateCommand> {
  if (
    !isEntityType(command.entityType) ||
    !UUID.test(command.candidateId) ||
    !UUID.test(command.sourceRecordId) ||
    !UUID.test(command.canonicalRecordId) ||
    command.sourceRecordId === command.canonicalRecordId ||
    !validRecordVersion(command.expectedCandidateRecordVersion) ||
    !validRecordVersion(command.expectedSourceRecordVersion) ||
    !validRecordVersion(command.expectedCanonicalRecordVersion) ||
    !SAFE_CODE.test(command.reasonCode) ||
    !SAFE_CODE.test(command.requestId)
  ) {
    throw new DuplicateMergeError("DUPLICATE_MERGE_COMMAND_INVALID");
  }
  validateIdempotency(command.idempotencyKey);
  const fieldSelections = normalizeFieldSelections(
    command.entityType,
    command.fieldSelections,
    command.sourceRecordId,
    command.canonicalRecordId,
  );
  return Object.freeze({
    ...command,
    fieldSelections,
    reasonCode: command.reasonCode.trim(),
    requestId: command.requestId.trim(),
  });
}

function normalizeUndoCommand(
  command: CorrectDuplicateMergeCommand,
): Readonly<CorrectDuplicateMergeCommand> {
  if (
    !UUID.test(command.mergeId) ||
    !validRecordVersion(command.expectedMergeRecordVersion) ||
    !SAFE_CODE.test(command.reasonCode) ||
    !SAFE_CODE.test(command.requestId)
  ) {
    throw new DuplicateMergeError("DUPLICATE_MERGE_COMMAND_INVALID");
  }
  validateIdempotency(command.idempotencyKey);
  return Object.freeze({
    ...command,
    reasonCode: command.reasonCode.trim(),
    requestId: command.requestId.trim(),
  });
}

function normalizeSignals(
  entityType: DuplicateEntityType,
  signals: readonly DuplicateMatchSignal[],
): readonly DuplicateMatchSignal[] {
  if (!Array.isArray(signals) || signals.length === 0) {
    throw new DuplicateMergeError("DUPLICATE_MERGE_COMMAND_INVALID");
  }
  const allowed = allowedSignals(entityType);
  const unique = new Set<DuplicateMatchSignal>();
  for (const signal of signals) {
    if (!allowed.includes(signal) || unique.has(signal)) {
      throw new DuplicateMergeError("DUPLICATE_MERGE_COMMAND_INVALID");
    }
    unique.add(signal);
  }
  return Object.freeze([...unique].sort());
}

function normalizeFieldSelections(
  entityType: DuplicateEntityType,
  fieldSelections: readonly MergeFieldSelection[],
  sourceRecordId: string,
  canonicalRecordId: string,
): readonly MergeFieldSelection[] {
  if (!Array.isArray(fieldSelections) || fieldSelections.length === 0) {
    throw new DuplicateMergeError("DUPLICATE_MERGE_COMMAND_INVALID");
  }
  const allowed = allowedFields(entityType);
  const fields = new Set<string>();
  const normalized: MergeFieldSelection[] = [];
  for (const selection of fieldSelections) {
    if (
      !selection ||
      typeof selection.fieldName !== "string" ||
      !allowed.includes(selection.fieldName) ||
      fields.has(selection.fieldName) ||
      (selection.sourceRecordId !== sourceRecordId && selection.sourceRecordId !== canonicalRecordId)
    ) {
      throw new DuplicateMergeError("DUPLICATE_MERGE_COMMAND_INVALID");
    }
    fields.add(selection.fieldName);
    normalized.push(Object.freeze({
      fieldName: selection.fieldName,
      sourceRecordId: selection.sourceRecordId,
    }));
  }
  return Object.freeze(normalized.sort((left, right) => left.fieldName.localeCompare(right.fieldName)));
}

function effectsFor(input: {
  readonly auditId: string;
  readonly outboxId: string;
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly eventType: string;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly requestId: string;
  readonly occurredAt: string;
  readonly effectType: string;
  readonly reasonCode: string | null;
}): MutationEffectBundle {
  const audit = buildAuditEvent({
    id: input.auditId,
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    actorKind: "user",
    eventType: input.eventType,
    eventVersion: 1,
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    outcome: "succeeded",
    requestId: input.requestId,
    occurredAt: input.occurredAt,
    metadata: {
      effect_type: input.effectType,
      record_version: 1,
      ...(input.reasonCode === null ? {} : { reason_code: input.reasonCode }),
    },
  });
  const outbox = buildOutboxMessage({
    id: input.outboxId,
    auditEventId: input.auditId,
    organizationId: input.organizationId,
    aggregateType: input.resourceType,
    aggregateId: input.resourceId,
    eventType: input.eventType,
    eventVersion: 1,
    idempotencyKey: `${input.effectType}-${input.outboxId}`,
    requestId: input.requestId,
    payload: {
      aggregate_id: input.resourceId,
      effect_type: input.effectType,
      operation: input.action,
      record_version: 1,
      request_id: input.requestId,
      status: "pending",
      ...(input.reasonCode === null ? {} : { reason_code: input.reasonCode }),
    },
    availableAt: input.occurredAt,
    createdAt: input.occurredAt,
  });
  return buildAtomicMutationEffects({ audit, outbox });
}

function allowedSignals(entityType: DuplicateEntityType): readonly DuplicateMatchSignal[] {
  switch (entityType) {
    case "student":
      return ["display_name", "date_of_birth", "email", "phone"];
    case "guardian":
      return ["display_name", "email", "phone"];
    case "school":
      return ["display_name", "official_website", "source_key"];
  }
}

function allowedFields(entityType: DuplicateEntityType): readonly string[] {
  switch (entityType) {
    case "student":
      return ["display_name", "date_of_birth", "contact_email", "contact_phone"];
    case "guardian":
      return ["display_name", "email", "phone"];
    case "school":
      return ["school_key", "school_name_zh", "school_name_en", "official_website"];
  }
}

function isEntityType(value: unknown): value is DuplicateEntityType {
  return (DUPLICATE_ENTITY_TYPES as readonly string[]).includes(value as string);
}

function validRecordVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function validNow(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new DuplicateMergeError("DUPLICATE_MERGE_COMMAND_INVALID");
  }
  return value;
}

function validateIdempotency(key: string): void {
  try {
    validateIdempotencyKey(key);
  } catch {
    throw new DuplicateMergeError("DUPLICATE_MERGE_COMMAND_INVALID");
  }
}
