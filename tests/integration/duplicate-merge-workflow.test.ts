import assert from "node:assert/strict";
import test from "node:test";

import {
  DuplicateMergeError,
  DuplicateMergeRuntimeUnavailable,
  DuplicateMergeService,
  getDuplicateMergeRuntime,
  type DuplicateCandidateResult,
  type DuplicateMergeRepository,
  type DuplicateMergeResult,
  type DuplicateMergeUndoResult,
} from "../../modules/crm/application/merge-service.ts";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const ADVISOR = Object.freeze({
  userId: "22222222-2222-4222-8222-222222222222",
  organizationId: ORGANIZATION_ID,
  role: "advisor" as const,
  sessionId: "33333333-3333-4333-8333-333333333333",
  capturedSessionVersion: 1,
  reauthenticatedAtMs: 1_754_265_600_000,
});
const FOUNDER = Object.freeze({
  ...ADVISOR,
  userId: "44444444-4444-4444-8444-444444444444",
  role: "founder" as const,
});
const SOURCE_ID = "55555555-5555-4555-8555-555555555555";
const CANONICAL_ID = "66666666-6666-4666-8666-666666666666";

class FixedClock {
  nowMs(): number {
    return 1_754_265_600_000;
  }
}

type CandidateInput = Parameters<DuplicateMergeRepository["createCandidate"]>[0];
type MergeInput = Parameters<DuplicateMergeRepository["mergeCandidate"]>[0];
type UndoInput = Parameters<DuplicateMergeRepository["undoMerge"]>[0];

type CandidateState = DuplicateCandidateResult & {
  readonly organizationId: string;
  appliedMergeId: string | null;
};

type MergeState = DuplicateMergeResult;

type AliasRevision = Readonly<{
  revisionId: string;
  sourceRecordId: string;
  canonicalRecordId: string | null;
}>;

type IdempotentResult =
  | DuplicateCandidateResult
  | DuplicateMergeResult
  | DuplicateMergeUndoResult;

/**
 * A transaction-shaped fake: each method computes and checks all preconditions
 * before exposing any candidate, merge, alias, provenance, audit, outbox, or
 * idempotency record.
 */
class InMemoryDuplicateMergeRepository implements DuplicateMergeRepository {
  private readonly records = new Map<string, number>();
  private readonly candidates = new Map<string, CandidateState>();
  private readonly merges = new Map<string, MergeState>();
  private readonly aliases: AliasRevision[] = [];
  private readonly provenanceRevisionIds: string[] = [];
  private readonly correctiveRevisionIds = new Map<string, string>();
  private readonly idempotency = new Map<string, { requestHash: string; result: IdempotentResult }>();
  private readonly effectBundles: unknown[] = [];
  private failNextCommit = false;

  registerRecord(entityType: CandidateInput["entityType"], id: string, recordVersion = 1): void {
    this.records.set(this.recordKey(entityType, id), recordVersion);
  }

  setRecordVersion(entityType: CandidateInput["entityType"], id: string, recordVersion: number): void {
    this.records.set(this.recordKey(entityType, id), recordVersion);
  }

  failOnceBeforeCommit(): void {
    this.failNextCommit = true;
  }

  async createCandidate(input: CandidateInput): Promise<DuplicateCandidateResult> {
    const scope = this.idempotencyScope("candidate", input.organizationId, input.idempotencyKey);
    const replay = this.replay<DuplicateCandidateResult>(scope, input.requestHash);
    if (replay) return replay;
    this.assertRegistered(input.entityType, input.leftRecordId);
    this.assertRegistered(input.entityType, input.rightRecordId);
    this.failIfRequested();

    const result: DuplicateCandidateResult = Object.freeze({
      candidateId: input.candidateId,
      entityType: input.entityType,
      leftRecordId: input.leftRecordId,
      rightRecordId: input.rightRecordId,
      leftRecordVersion: this.records.get(this.recordKey(input.entityType, input.leftRecordId)) ?? 0,
      rightRecordVersion: this.records.get(this.recordKey(input.entityType, input.rightRecordId)) ?? 0,
      matchingSignals: input.matchingSignals,
      status: "review_required",
      recordVersion: 1,
    });
    this.candidates.set(input.candidateId, {
      ...result,
      organizationId: input.organizationId,
      appliedMergeId: null,
    });
    this.effectBundles.push(input.effects);
    this.idempotency.set(scope, { requestHash: input.requestHash, result });
    return result;
  }

  async mergeCandidate(input: MergeInput): Promise<DuplicateMergeResult> {
    const scope = this.idempotencyScope("merge", input.organizationId, input.idempotencyKey);
    const replay = this.replay<DuplicateMergeResult>(scope, input.requestHash);
    if (replay) return replay;

    const candidate = this.candidates.get(input.candidateId);
    if (!candidate || candidate.organizationId !== input.organizationId) {
      throw new DuplicateMergeError("DUPLICATE_MERGE_CANDIDATE_NOT_FOUND");
    }
    if (candidate.recordVersion !== input.expectedCandidateRecordVersion) {
      throw new DuplicateMergeError("DUPLICATE_MERGE_CANDIDATE_STALE");
    }
    if (
      candidate.entityType !== input.entityType ||
      !sameCandidatePair(candidate, input.sourceRecordId, input.canonicalRecordId)
    ) {
      throw new DuplicateMergeError("DUPLICATE_MERGE_CANDIDATE_PAIR_MISMATCH");
    }
    if (candidate.appliedMergeId !== null || this.aliasTarget(input.sourceRecordId) !== input.sourceRecordId) {
      throw new DuplicateMergeError("DUPLICATE_MERGE_ALREADY_APPLIED");
    }
    this.assertVersion(input.entityType, input.sourceRecordId, input.expectedSourceRecordVersion);
    this.assertVersion(input.entityType, input.canonicalRecordId, input.expectedCanonicalRecordVersion);
    this.failIfRequested();

    const result: DuplicateMergeResult = Object.freeze({
      mergeId: input.mergeId,
      candidateId: input.candidateId,
      entityType: input.entityType,
      sourceRecordId: input.sourceRecordId,
      canonicalRecordId: input.canonicalRecordId,
      fieldProvenanceRevisionId: input.fieldProvenanceRevisionId,
      recordVersion: 1,
    });
    candidate.appliedMergeId = result.mergeId;
    this.merges.set(result.mergeId, result);
    this.aliases.push({
      revisionId: result.mergeId,
      sourceRecordId: result.sourceRecordId,
      canonicalRecordId: result.canonicalRecordId,
    });
    this.provenanceRevisionIds.push(result.fieldProvenanceRevisionId);
    this.effectBundles.push(input.effects);
    this.idempotency.set(scope, { requestHash: input.requestHash, result });
    return result;
  }

  async undoMerge(input: UndoInput): Promise<DuplicateMergeUndoResult> {
    const scope = this.idempotencyScope("undo", input.organizationId, input.idempotencyKey);
    const replay = this.replay<DuplicateMergeUndoResult>(scope, input.requestHash);
    if (replay) return replay;

    const merge = this.merges.get(input.mergeId);
    if (!merge || input.organizationId !== ORGANIZATION_ID) {
      throw new DuplicateMergeError("DUPLICATE_MERGE_NOT_FOUND");
    }
    if (merge.recordVersion !== input.expectedMergeRecordVersion) {
      throw new DuplicateMergeError("DUPLICATE_MERGE_STALE");
    }
    if (this.correctiveRevisionIds.has(merge.mergeId)) {
      throw new DuplicateMergeError("DUPLICATE_MERGE_NOT_ACTIVE");
    }
    if (this.aliasTarget(merge.sourceRecordId) !== merge.canonicalRecordId) {
      throw new DuplicateMergeError("DUPLICATE_MERGE_NOT_ACTIVE");
    }
    this.failIfRequested();

    const result: DuplicateMergeUndoResult = Object.freeze({
      correctiveRevisionId: input.correctiveRevisionId,
      mergeId: merge.mergeId,
      entityType: merge.entityType,
      sourceRecordId: merge.sourceRecordId,
      canonicalRecordId: merge.canonicalRecordId,
      restoredAliasTargetId: merge.sourceRecordId,
      recordVersion: 1,
    });
    this.correctiveRevisionIds.set(merge.mergeId, result.correctiveRevisionId);
    this.aliases.push({
      revisionId: result.correctiveRevisionId,
      sourceRecordId: result.sourceRecordId,
      canonicalRecordId: null,
    });
    this.provenanceRevisionIds.push(result.correctiveRevisionId);
    this.effectBundles.push(input.effects);
    this.idempotency.set(scope, { requestHash: input.requestHash, result });
    return result;
  }

  aliasTarget(sourceRecordId: string): string {
    const newest = [...this.aliases].reverse().find((alias) => alias.sourceRecordId === sourceRecordId);
    return newest?.canonicalRecordId ?? sourceRecordId;
  }

  aliasHistory(sourceRecordId: string): readonly AliasRevision[] {
    return this.aliases.filter((alias) => alias.sourceRecordId === sourceRecordId);
  }

  merge(mergeId: string): DuplicateMergeResult | undefined {
    return this.merges.get(mergeId);
  }

  snapshot(): Readonly<{
    candidates: number;
    merges: number;
    aliases: number;
    provenanceRevisions: number;
    idempotency: number;
    auditsAndOutbox: number;
  }> {
    return Object.freeze({
      candidates: this.candidates.size,
      merges: this.merges.size,
      aliases: this.aliases.length,
      provenanceRevisions: this.provenanceRevisionIds.length,
      idempotency: this.idempotency.size,
      auditsAndOutbox: this.effectBundles.length,
    });
  }

  serializedEffects(): string {
    return JSON.stringify(this.effectBundles);
  }

  private replay<T extends IdempotentResult>(scope: string, requestHash: string): T | null {
    const existing = this.idempotency.get(scope);
    if (!existing) return null;
    if (existing.requestHash !== requestHash) {
      throw new DuplicateMergeError("DUPLICATE_MERGE_IDEMPOTENCY_KEY_REUSED");
    }
    return existing.result as T;
  }

  private assertRegistered(entityType: CandidateInput["entityType"], id: string): void {
    if (!this.records.has(this.recordKey(entityType, id))) {
      throw new DuplicateMergeError("DUPLICATE_MERGE_RECORD_NOT_FOUND");
    }
  }

  private assertVersion(entityType: CandidateInput["entityType"], id: string, expected: number): void {
    this.assertRegistered(entityType, id);
    if (this.records.get(this.recordKey(entityType, id)) !== expected) {
      throw new DuplicateMergeError("DUPLICATE_MERGE_RECORD_STALE");
    }
  }

  private failIfRequested(): void {
    if (this.failNextCommit) {
      this.failNextCommit = false;
      throw new Error("synthetic duplicate merge transaction failure");
    }
  }

  private idempotencyScope(operation: string, organizationId: string, key: string): string {
    return `${operation}:${organizationId}:${key}`;
  }

  private recordKey(entityType: CandidateInput["entityType"], id: string): string {
    return `${entityType}:${id}`;
  }
}

test("candidate detection creates a review item only and never an alias or merge", async () => {
  const { repository, service } = createScenario(100);

  const result = await service.createCandidate({ actor: ADVISOR, command: candidateCommand() });

  assert.deepEqual(result, {
    candidateId: "00000000-0000-4000-8000-000000000101",
    entityType: "student",
    leftRecordId: SOURCE_ID,
    rightRecordId: CANONICAL_ID,
    leftRecordVersion: 1,
    rightRecordVersion: 1,
    matchingSignals: ["date_of_birth", "display_name"],
    status: "review_required",
    recordVersion: 1,
  });
  assert.equal(repository.aliasTarget(SOURCE_ID), SOURCE_ID);
  assert.deepEqual(repository.snapshot(), {
    candidates: 1,
    merges: 0,
    aliases: 0,
    provenanceRevisions: 0,
    idempotency: 1,
    auditsAndOutbox: 1,
  });
  assert.doesNotMatch(repository.serializedEffects(), /display_name|date_of_birth/i);
});

test("a Founder merges an exact candidate with append-only aliases and field provenance", async () => {
  const { repository, service } = createScenario(200);
  const candidate = await service.createCandidate({ actor: ADVISOR, command: candidateCommand() });
  const input = {
    actor: FOUNDER,
    command: mergeCommand({ candidateId: candidate.candidateId }),
  };

  const result = await service.mergeCandidate(input);
  assert.deepEqual(await service.mergeCandidate(input), result);

  assert.equal(result.entityType, "student");
  assert.equal(result.sourceRecordId, SOURCE_ID);
  assert.equal(result.canonicalRecordId, CANONICAL_ID);
  assert.equal(repository.aliasTarget(SOURCE_ID), CANONICAL_ID);
  assert.deepEqual(repository.aliasHistory(SOURCE_ID), [
    {
      revisionId: result.mergeId,
      sourceRecordId: SOURCE_ID,
      canonicalRecordId: CANONICAL_ID,
    },
  ]);
  assert.deepEqual(repository.snapshot(), {
    candidates: 1,
    merges: 1,
    aliases: 1,
    provenanceRevisions: 1,
    idempotency: 2,
    auditsAndOutbox: 2,
  });
  assert.doesNotMatch(repository.serializedEffects(), /source_record|canonical_record|display_name/i);

  await assert.rejects(
    service.mergeCandidate({
      ...input,
      command: {
        ...input.command,
        fieldSelections: [{ fieldName: "contact_phone", sourceRecordId: SOURCE_ID }],
      },
    }),
    duplicateError("DUPLICATE_MERGE_IDEMPOTENCY_KEY_REUSED"),
  );
  assert.equal(repository.merge(result.mergeId)?.recordVersion, 1);
});

test("a merge is Founder-only and stale source records do not create partial facts", async () => {
  const { repository, service } = createScenario(300);
  const candidate = await service.createCandidate({ actor: ADVISOR, command: candidateCommand() });
  const before = repository.snapshot();

  await assert.rejects(
    service.mergeCandidate({ actor: ADVISOR, command: mergeCommand({ candidateId: candidate.candidateId }) }),
    duplicateError("DUPLICATE_MERGE_FOUNDER_REQUIRED"),
  );
  assert.deepEqual(repository.snapshot(), before);

  repository.setRecordVersion("student", SOURCE_ID, 2);
  await assert.rejects(
    service.mergeCandidate({ actor: FOUNDER, command: mergeCommand({ candidateId: candidate.candidateId }) }),
    duplicateError("DUPLICATE_MERGE_RECORD_STALE"),
  );
  assert.deepEqual(repository.snapshot(), before);
});

test("a failed merge transaction preserves the candidate and exposes no alias, provenance, or effect", async () => {
  const { repository, service } = createScenario(400);
  const candidate = await service.createCandidate({ actor: ADVISOR, command: candidateCommand() });
  const before = repository.snapshot();
  repository.failOnceBeforeCommit();

  await assert.rejects(
    service.mergeCandidate({ actor: FOUNDER, command: mergeCommand({ candidateId: candidate.candidateId }) }),
    /synthetic duplicate merge transaction failure/,
  );
  assert.deepEqual(repository.snapshot(), before);
  assert.equal(repository.aliasTarget(SOURCE_ID), SOURCE_ID);
});

test("a Founder undo appends a corrective revision and restores the source mapping without rewriting merge history", async () => {
  const { repository, service } = createScenario(500);
  const candidate = await service.createCandidate({ actor: ADVISOR, command: candidateCommand() });
  const merge = await service.mergeCandidate({
    actor: FOUNDER,
    command: mergeCommand({ candidateId: candidate.candidateId }),
  });
  const undoInput = {
    actor: FOUNDER,
    command: undoCommand({ mergeId: merge.mergeId }),
  };

  const undo = await service.undoMerge(undoInput);
  assert.deepEqual(await service.undoMerge(undoInput), undo);
  assert.equal(repository.aliasTarget(SOURCE_ID), SOURCE_ID);
  assert.deepEqual(repository.merge(merge.mergeId), merge);
  assert.deepEqual(repository.aliasHistory(SOURCE_ID), [
    {
      revisionId: merge.mergeId,
      sourceRecordId: SOURCE_ID,
      canonicalRecordId: CANONICAL_ID,
    },
    {
      revisionId: undo.correctiveRevisionId,
      sourceRecordId: SOURCE_ID,
      canonicalRecordId: null,
    },
  ]);
  assert.deepEqual(repository.snapshot(), {
    candidates: 1,
    merges: 1,
    aliases: 2,
    provenanceRevisions: 2,
    idempotency: 3,
    auditsAndOutbox: 3,
  });

  await assert.rejects(
    service.undoMerge({
      actor: FOUNDER,
      command: undoCommand({
        mergeId: merge.mergeId,
        idempotencyKey: "duplicate-undo-second",
        requestId: "duplicate.undo.second",
      }),
    }),
    duplicateError("DUPLICATE_MERGE_NOT_ACTIVE"),
  );
});

test("the duplicate merge runtime fails closed without the configured HK RDS adapter", () => {
  assert.throws(() => getDuplicateMergeRuntime(), DuplicateMergeRuntimeUnavailable);
});

function createScenario(startingId: number) {
  const repository = new InMemoryDuplicateMergeRepository();
  repository.registerRecord("student", SOURCE_ID);
  repository.registerRecord("student", CANONICAL_ID);
  let nextId = startingId;
  const service = new DuplicateMergeService({
    repository,
    clock: new FixedClock(),
    createId: () => {
      nextId += 1;
      return `00000000-0000-4000-8000-${String(nextId).padStart(12, "0")}`;
    },
  });
  return { repository, service };
}

function candidateCommand(overrides: Record<string, unknown> = {}) {
  return {
    entityType: "student" as const,
    leftRecordId: SOURCE_ID,
    rightRecordId: CANONICAL_ID,
    matchingSignals: ["display_name", "date_of_birth"] as const,
    requestId: "duplicate.candidate.create",
    idempotencyKey: "duplicate-candidate-create",
    ...overrides,
  };
}

function mergeCommand(overrides: Record<string, unknown> = {}) {
  return {
    candidateId: "00000000-0000-4000-8000-000000000201",
    entityType: "student" as const,
    sourceRecordId: SOURCE_ID,
    canonicalRecordId: CANONICAL_ID,
    expectedCandidateRecordVersion: 1,
    expectedSourceRecordVersion: 1,
    expectedCanonicalRecordVersion: 1,
    fieldSelections: [
      { fieldName: "display_name", sourceRecordId: CANONICAL_ID },
      { fieldName: "date_of_birth", sourceRecordId: SOURCE_ID },
    ],
    reasonCode: "duplicate.record.correction",
    requestId: "duplicate.merge.approve",
    idempotencyKey: "duplicate-merge-approve",
    ...overrides,
  };
}

function undoCommand(overrides: Record<string, unknown> = {}) {
  return {
    mergeId: "00000000-0000-4000-8000-000000000204",
    expectedMergeRecordVersion: 1,
    reasonCode: "duplicate.merge.undo",
    requestId: "duplicate.merge.undo",
    idempotencyKey: "duplicate-merge-undo",
    ...overrides,
  };
}

function duplicateError(code: DuplicateMergeError["code"]) {
  return (error: unknown) => error instanceof DuplicateMergeError && error.code === code;
}

function sameCandidatePair(
  candidate: DuplicateCandidateResult,
  sourceRecordId: string,
  canonicalRecordId: string,
): boolean {
  return (
    (candidate.leftRecordId === sourceRecordId && candidate.rightRecordId === canonicalRecordId) ||
    (candidate.leftRecordId === canonicalRecordId && candidate.rightRecordId === sourceRecordId)
  );
}
