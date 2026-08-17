import { randomUUID } from "node:crypto";

import {
  ReconstructionError,
  type ReconstructionActor,
  type ReconstructionAggregate,
  type ReconstructionCommandBase,
  type ReconstructionCreateCommand,
  type ReconstructionHistoryEvent,
  type ReconstructionHistoryGap,
  type ReconstructionIdempotencyReceipt,
  type ReconstructionIdempotencyScope,
  type ReconstructionResult,
  type ReconstructionVersion,
} from "../../modules/cases/domain/reconstruction/contract.ts";
import type {
  CaseReconstructionRepository,
  ReconstructionWriteContext,
} from "../../modules/cases/application/reconstruction/repository-port.ts";

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_ORGANIZATION_ID = "10000000-0000-4000-8000-000000000002";
const ADVISOR_ID = "20000000-0000-4000-8000-000000000001";
const OTHER_ADVISOR_ID = "20000000-0000-4000-8000-000000000002";
const FOUNDER_ID = "30000000-0000-4000-8000-000000000001";
const CASE_ID = "40000000-0000-4000-8000-000000000001";
const OTHER_CASE_ID = "40000000-0000-4000-8000-000000000002";

interface Stored {
  aggregate: ReconstructionAggregate;
  versions: Map<string, ReconstructionVersion>;
  events: Map<string, ReconstructionHistoryEvent[]>;
  gaps: Map<string, ReconstructionHistoryGap[]>;
}

export class FakeCaseReconstructionRepository implements CaseReconstructionRepository {
  readonly advisor: ReconstructionActor = actor(ADVISOR_ID, ORGANIZATION_ID, "advisor");
  readonly otherAdvisor: ReconstructionActor = actor(OTHER_ADVISOR_ID, ORGANIZATION_ID, "advisor");
  readonly founder: ReconstructionActor = actor(FOUNDER_ID, ORGANIZATION_ID, "founder");
  readonly otherOrganizationFounder: ReconstructionActor = actor(
    "30000000-0000-4000-8000-000000000002",
    OTHER_ORGANIZATION_ID,
    "founder",
  );
  readonly serviceCaseId = CASE_ID;
  readonly otherServiceCaseId = OTHER_CASE_ID;
  readonly approvedPilotReferences = new Set(["pilot-ref-01"]);
  readonly assignedAdvisorByPilot = new Map([[this.pilotKey("pilot-ref-01"), ADVISOR_ID]]);
  /** Kept as an explicit case assignment fixture for activation-only checks. */
  readonly assignedAdvisorByCase = new Map([[CASE_ID, ADVISOR_ID]]);
  readonly availableServiceCaseIds = new Set([CASE_ID]);
  readonly committedFacts: ReconstructionHistoryEvent[] = [];
  readonly committedHistory: ReconstructionHistoryEvent[] = [];
  readonly committedGaps: ReconstructionHistoryGap[] = [];
  readonly auditEvents: unknown[] = [];
  readonly outboxMessages: unknown[] = [];
  readonly idempotencyReceipts = new Map<string, ReconstructionIdempotencyReceipt>();
  readonly inProgressIdempotencyKeys = new Set<string>();
  failBeforeCommit = false;
  /** Simulates a durable commit followed by a lost response. */
  uncertainAfterCommit = false;
  failAfterCommitUncertainty = false;

  private readonly records = new Map<string, Stored>();

  command(suffix: string, overrides: Partial<ReconstructionCreateCommand> = {}): ReconstructionCreateCommand {
    return {
      pilotReference: "pilot-ref-01",
      requestId: `request-${suffix}`,
      idempotencyKey: `idempotency-${suffix}`,
      ...overrides,
    };
  }

  baseCommand(suffix: string, expectedRecordVersion: number): ReconstructionCommandBase {
    return {
      requestId: `request-${suffix}`,
      idempotencyKey: `idempotency-${suffix}`,
      expectedRecordVersion,
    };
  }

  async createDraft(input: Parameters<CaseReconstructionRepository["createDraft"]>[0]): Promise<ReconstructionResult> {
    return this.transact(input.idempotencyKey, input.requestHash, input.idempotencyScope, () => {
      if (!this.approvedPilotReferences.has(input.command.pilotReference)) {
        throw new ReconstructionError("RECONSTRUCTION_PILOT_NOT_APPROVED");
      }
      this.requireAdvisor(input.actor, input.command.pilotReference);
      const pilotKey = this.pilotKey(input.command.pilotReference, input.organizationId);
      if ([...this.records.values()].some((record) =>
        record.aggregate.organizationId === input.organizationId &&
        record.aggregate.pilotReference === input.command.pilotReference,
      )) {
        throw new ReconstructionError("RECONSTRUCTION_STATE_INVALID");
      }
      const version: ReconstructionVersion = {
        id: input.reconstructionVersionId,
        reconstructionId: input.reconstructionId,
        organizationId: input.organizationId,
        serviceCaseId: null,
        pilotReference: input.command.pilotReference,
        versionNo: 1,
        reviewCycle: 0,
        state: "draft",
        recorderUserId: input.actor.userId,
        reviewerUserId: null,
        recordVersion: 1,
      };
      const aggregate: ReconstructionAggregate = {
        id: input.reconstructionId,
        organizationId: input.organizationId,
        serviceCaseId: null,
        pilotReference: input.command.pilotReference,
        assignedAdvisorUserId: input.actor.userId,
        currentVersionId: input.reconstructionVersionId,
        currentVersionNo: 1,
        state: "draft",
        reviewCycle: 0,
        recordVersion: 1,
        activatedVersionId: null,
      };
      const stored: Stored = {
        aggregate,
        versions: new Map([[version.id, version]]),
        events: new Map([[version.id, []]]),
        gaps: new Map([[version.id, []]]),
      };
      this.records.set(input.reconstructionId, stored);
      void pilotKey;
      return snapshot(stored);
    });
  }

  async appendEvent(input: Parameters<CaseReconstructionRepository["appendEvent"]>[0]): Promise<ReconstructionResult> {
    return this.mutate(input, (stored, version) => {
      this.requireAdvisor(input.actor, stored.aggregate.pilotReference);
      this.requireState(version, "draft");
      const events = stored.events.get(version.id) ?? [];
      const last = events.at(-1);
      if (last && compareOrder(input.event.occurredAt, input.event.sequenceNo, last) <= 0) {
        throw new ReconstructionError("RECONSTRUCTION_ORDER_INVALID");
      }
      events.push({
        ...input.event,
        id: input.eventId,
        organizationId: stored.aggregate.organizationId,
        reconstructionId: stored.aggregate.id,
        reconstructionVersionId: version.id,
        versionNo: version.versionNo,
        recordedAt: input.recordedAt,
        recorderUserId: input.actor.userId,
        correctedByUserId: null,
        correctionOfEventId: null,
        correctionReasonCode: null,
        expectedRecordVersion: input.expectedRecordVersion,
      });
      this.incrementAggregate(stored, version.id);
    });
  }

  async appendGap(input: Parameters<CaseReconstructionRepository["appendGap"]>[0]): Promise<ReconstructionResult> {
    return this.mutate(input, (stored, version) => {
      this.requireAdvisor(input.actor, stored.aggregate.pilotReference);
      this.requireState(version, "draft");
      const gaps = stored.gaps.get(version.id) ?? [];
      gaps.push({
        ...input.gap,
        id: input.gapId,
        organizationId: stored.aggregate.organizationId,
        reconstructionId: stored.aggregate.id,
        reconstructionVersionId: version.id,
        versionNo: version.versionNo,
        founderDecision: "pending",
        recordVersion: 1,
      });
      this.incrementAggregate(stored, version.id);
    });
  }

  async submit(input: ReconstructionWriteContext): Promise<ReconstructionResult> {
    return this.mutate(input, (stored, version) => {
      this.requireAdvisor(input.actor, stored.aggregate.pilotReference);
      this.requireState(version, "draft");
      const events = stored.events.get(version.id) ?? [];
      const gaps = stored.gaps.get(version.id) ?? [];
      if (events.length === 0 && gaps.length === 0) throw new ReconstructionError("RECONSTRUCTION_STATE_INVALID");
      this.replaceVersion(stored, { ...version, state: "submitted" });
      this.incrementAggregate(stored, version.id);
    });
  }

  async requestChanges(input: ReconstructionWriteContext): Promise<ReconstructionResult> {
    return this.mutate(input, (stored, version) => {
      this.requireFounder(input.actor, version);
      this.requireState(version, "submitted");
      const nextCycle = stored.aggregate.reviewCycle + 1;
      const nextState = nextCycle >= 3 ? "needs_human" : "changes_requested";
      this.replaceVersion(stored, {
        ...version,
        state: nextState,
        reviewCycle: nextCycle,
        reviewerUserId: input.actor.userId,
      });
      stored.aggregate = { ...stored.aggregate, state: nextState, reviewCycle: nextCycle, recordVersion: stored.aggregate.recordVersion + 1 };
    });
  }

  async createNextDraft(input: Parameters<CaseReconstructionRepository["createNextDraft"]>[0]): Promise<ReconstructionResult> {
    return this.mutate(input, (stored, version) => {
      this.requireAdvisor(input.actor, stored.aggregate.pilotReference);
      this.requireState(version, "changes_requested");
      const nextVersion: ReconstructionVersion = {
        id: input.nextReconstructionVersionId,
        reconstructionId: stored.aggregate.id,
        organizationId: stored.aggregate.organizationId,
        serviceCaseId: stored.aggregate.serviceCaseId,
        pilotReference: stored.aggregate.pilotReference,
        versionNo: version.versionNo + 1,
        reviewCycle: version.reviewCycle,
        state: "draft",
        recorderUserId: input.actor.userId,
        reviewerUserId: null,
        recordVersion: stored.aggregate.recordVersion + 1,
      };
      const oldEvents = stored.events.get(version.id) ?? [];
      const oldGaps = stored.gaps.get(version.id) ?? [];
      stored.versions.set(nextVersion.id, nextVersion);
      stored.events.set(nextVersion.id, oldEvents.map((event) => ({
        ...event,
        id: randomUUID(),
        reconstructionVersionId: nextVersion.id,
        versionNo: nextVersion.versionNo,
        correctionOfEventId: event.correctionOfEventId,
      })));
      stored.gaps.set(nextVersion.id, oldGaps.map((gap) => ({
        ...gap,
        id: randomUUID(),
        reconstructionVersionId: nextVersion.id,
        versionNo: nextVersion.versionNo,
        founderDecision: "pending",
        recordVersion: 1,
      })));
      stored.aggregate = {
        ...stored.aggregate,
        currentVersionId: nextVersion.id,
        currentVersionNo: nextVersion.versionNo,
        state: "draft",
        recordVersion: stored.aggregate.recordVersion + 1,
      };
    });
  }

  async approve(input: ReconstructionWriteContext): Promise<ReconstructionResult> {
    return this.mutate(input, (stored, version) => {
      this.requireFounder(input.actor, version);
      this.requireState(version, "submitted");
      this.replaceVersion(stored, { ...version, state: "approved", reviewerUserId: input.actor.userId });
      const gaps = (stored.gaps.get(version.id) ?? []).map((gap) => ({
        ...gap,
        founderDecision: "approved" as const,
        recordVersion: gap.recordVersion + 1,
      }));
      stored.gaps.set(version.id, gaps);
      this.incrementAggregate(stored, version.id, "approved");
    });
  }

  async activate(input: Parameters<CaseReconstructionRepository["activate"]>[0]): Promise<ReconstructionResult> {
    const context: ReconstructionWriteContext = {
      ...input,
      recordedAt: input.activatedAt,
    };
    return this.mutate(context, (stored, version) => {
      this.requireFounder(input.actor, version);
      this.requireState(version, "approved");
      if (!input.serviceCaseBinding) throw new ReconstructionError("RECONSTRUCTION_SERVICE_CASE_BINDING_REQUIRED");
      if (input.serviceCaseBinding.organizationId !== stored.aggregate.organizationId) {
        throw new ReconstructionError("RECONSTRUCTION_SERVICE_CASE_NOT_FOUND");
      }
      if (!this.availableServiceCaseIds.has(input.serviceCaseBinding.serviceCaseId)) {
        throw new ReconstructionError("RECONSTRUCTION_SERVICE_CASE_NOT_FOUND");
      }
      if (stored.aggregate.serviceCaseId !== null) {
        throw new ReconstructionError("RECONSTRUCTION_SERVICE_CASE_ALREADY_BOUND");
      }
      if ((stored.gaps.get(version.id) ?? []).some((gap) => gap.founderDecision !== "approved")) {
        throw new ReconstructionError("RECONSTRUCTION_GAP_NOT_APPROVED");
      }
      if (input.effects.outbox.eventType !== "case_reconstruction.activated.v1") {
        throw new ReconstructionError("RECONSTRUCTION_INVALID_INPUT");
      }
      stored.aggregate = {
        ...stored.aggregate,
        serviceCaseId: input.serviceCaseBinding.serviceCaseId,
        state: "activated",
        activatedVersionId: version.id,
        recordVersion: stored.aggregate.recordVersion + 1,
      };
      this.committedFacts.push(...(stored.events.get(version.id) ?? []).map((event) => ({ ...event })));
      this.committedHistory.push(...(stored.events.get(version.id) ?? []).map((event) => ({ ...event })));
      this.committedGaps.push(...(stored.gaps.get(version.id) ?? []).map((gap) => ({ ...gap })));
      this.auditEvents.push(input.effects.audit);
      this.outboxMessages.push(input.effects.outbox);
    });
  }

  async appendCorrection(input: Parameters<CaseReconstructionRepository["appendCorrection"]>[0]): Promise<ReconstructionResult> {
    return this.mutate(input, (stored, version) => {
      this.requireAdvisor(input.actor, stored.aggregate.pilotReference);
      this.requireState(version, "approved");
      if (stored.aggregate.state !== "activated") throw new ReconstructionError("RECONSTRUCTION_STATE_INVALID");
      const target = [...stored.events.values()].flat().find((event) => event.id === input.correctionOfEventId);
      if (!target || target.organizationId !== stored.aggregate.organizationId || target.reconstructionId !== stored.aggregate.id) {
        throw new ReconstructionError("RECONSTRUCTION_CORRECTION_TARGET_INVALID");
      }
      if (target.correctionOfEventId !== null) {
        throw new ReconstructionError("RECONSTRUCTION_CORRECTION_OF_CORRECTION");
      }
      const correction: ReconstructionHistoryEvent = {
        ...input.event,
        id: input.correctionId,
        organizationId: stored.aggregate.organizationId,
        reconstructionId: stored.aggregate.id,
        reconstructionVersionId: version.id,
        versionNo: version.versionNo,
        recordedAt: input.recordedAt,
        recorderUserId: input.actor.userId,
        correctedByUserId: input.actor.userId,
        correctionOfEventId: input.correctionOfEventId,
        correctionReasonCode: input.reasonCode,
        expectedRecordVersion: input.expectedRecordVersion,
      };
      const events = stored.events.get(version.id) ?? [];
      events.push(correction);
      this.committedFacts.push({ ...correction });
      this.committedHistory.push({ ...correction });
      this.auditEvents.push(input.audit);
      this.incrementAggregate(stored, version.id);
    });
  }

  get(reconstructionId: string): ReconstructionResult | undefined {
    const value = this.records.get(reconstructionId);
    return value ? snapshot(value) : undefined;
  }

  getVersion(reconstructionId: string, reconstructionVersionId: string): ReconstructionResult | undefined {
    const value = this.records.get(reconstructionId);
    return value?.versions.has(reconstructionVersionId) ? snapshot(value, reconstructionVersionId) : undefined;
  }

  reconcile(idempotencyKey: string): ReconstructionResult | undefined {
    const receipt = this.idempotencyReceipts.get(idempotencyKey);
    if (!receipt || receipt.state !== "failed_reconcilable") return undefined;
    const aggregateId = receipt.scope.aggregateId;
    return aggregateId ? this.get(aggregateId) : undefined;
  }

  private async mutate(
    input: ReconstructionWriteContext,
    change: (stored: Stored, version: ReconstructionVersion) => Stored | void,
  ): Promise<ReconstructionResult> {
    return this.transact(input.idempotencyKey, input.requestHash, input.idempotencyScope, () => {
      const current = this.records.get(input.reconstructionId);
      if (!current || current.aggregate.organizationId !== input.organizationId) {
        throw new ReconstructionError("RECONSTRUCTION_NOT_FOUND");
      }
      if (current.aggregate.recordVersion !== input.expectedRecordVersion) {
        throw new ReconstructionError("VERSION_CONFLICT", current.aggregate.recordVersion);
      }
      const working = clone(current);
      const version = working.versions.get(working.aggregate.currentVersionId);
      if (!version) throw new ReconstructionError("RECONSTRUCTION_NOT_FOUND");
      const replacement = change(working, version) ?? working;
      this.records.set(replacement.aggregate.id, replacement);
      return snapshot(replacement);
    });
  }

  private async transact(
    key: string,
    hash: string,
    scope: ReconstructionIdempotencyScope,
    operation: () => ReconstructionResult,
  ): Promise<ReconstructionResult> {
    const existing = this.idempotencyReceipts.get(key);
    if (existing) {
      if (existing.requestHash !== hash) throw new ReconstructionError("RECONSTRUCTION_IDEMPOTENCY_KEY_REUSED");
      if (existing.state === "in_progress") throw new ReconstructionError("RECONSTRUCTION_IDEMPOTENCY_IN_PROGRESS");
      if (existing.state === "failed_reconcilable") {
        throw new ReconstructionError("RECONSTRUCTION_COMMIT_OUTCOME_UNKNOWN");
      }
      if (!existing.result) throw new ReconstructionError("RECONSTRUCTION_COMMIT_OUTCOME_UNKNOWN");
      return snapshotResult(existing.result, "replayed");
    }
    if (this.inProgressIdempotencyKeys.has(key)) {
      throw new ReconstructionError("RECONSTRUCTION_IDEMPOTENCY_IN_PROGRESS");
    }
    const before = this.capture();
    this.idempotencyReceipts.set(key, {
      idempotencyKey: key,
      scope,
      requestHash: hash,
      state: "in_progress",
      result: null,
      errorCode: null,
    });
    try {
      const result = operation();
      if (this.failBeforeCommit) throw new Error("FAKE_FAIL_BEFORE_COMMIT");
      const frozen = snapshotResult(result, "committed");
      if (this.uncertainAfterCommit || this.failAfterCommitUncertainty) {
        this.idempotencyReceipts.set(key, {
          idempotencyKey: key,
          scope,
          requestHash: hash,
          state: "failed_reconcilable",
          result: frozen,
          errorCode: "RECONSTRUCTION_COMMIT_OUTCOME_UNKNOWN",
        });
        throw new ReconstructionError("RECONSTRUCTION_COMMIT_OUTCOME_UNKNOWN");
      }
      this.idempotencyReceipts.set(key, {
        idempotencyKey: key,
        scope,
        requestHash: hash,
        state: "completed",
        result: frozen,
        errorCode: null,
      });
      return frozen;
    } catch (error) {
      if (error instanceof ReconstructionError && error.code === "RECONSTRUCTION_COMMIT_OUTCOME_UNKNOWN") return Promise.reject(error);
      this.restore(before);
      this.idempotencyReceipts.delete(key);
      throw error;
    }
  }

  private requireAdvisor(actorValue: ReconstructionActor, pilotReference: string): void {
    if (actorValue.role !== "advisor" || this.assignedAdvisorByPilot.get(this.pilotKey(pilotReference, actorValue.organizationId)) !== actorValue.userId) {
      throw new ReconstructionError("RECONSTRUCTION_NOT_ASSIGNED");
    }
  }

  private requireFounder(actorValue: ReconstructionActor, version: ReconstructionVersion): void {
    if (actorValue.role !== "founder") throw new ReconstructionError("RECONSTRUCTION_FOUNDER_REQUIRED");
    if (actorValue.userId === version.recorderUserId) throw new ReconstructionError("RECONSTRUCTION_REVIEWER_IS_RECORDER");
  }

  private requireState(version: ReconstructionVersion, state: ReconstructionVersion["state"]): void {
    if (version.state !== state) throw new ReconstructionError("RECONSTRUCTION_STATE_INVALID");
  }

  private incrementAggregate(stored: Stored, versionId: string, state?: ReconstructionVersion["state"]): void {
    const version = stored.versions.get(versionId);
    if (!version) throw new ReconstructionError("RECONSTRUCTION_NOT_FOUND");
    const nextVersionState = state ?? version.state;
    const nextAggregateState = stored.aggregate.state === "activated" ? "activated" : nextVersionState;
    const nextVersion = { ...version, state: nextVersionState, recordVersion: stored.aggregate.recordVersion + 1 };
    this.replaceVersion(stored, nextVersion);
    stored.aggregate = {
      ...stored.aggregate,
      state: nextAggregateState,
      recordVersion: stored.aggregate.recordVersion + 1,
      currentVersionId: versionId,
      currentVersionNo: version.versionNo,
    };
  }

  private replaceVersion(stored: Stored, version: ReconstructionVersion): void {
    stored.versions.set(version.id, version);
  }

  private capture() {
    return {
      records: new Map([...this.records].map(([key, value]) => [key, clone(value)])),
      facts: [...this.committedFacts],
      history: [...this.committedHistory],
      gaps: [...this.committedGaps],
      audit: [...this.auditEvents],
      outbox: [...this.outboxMessages],
    };
  }

  private restore(state: ReturnType<FakeCaseReconstructionRepository["capture"]>): void {
    this.records.clear();
    for (const [key, value] of state.records) this.records.set(key, value);
    this.committedFacts.splice(0, Infinity, ...state.facts);
    this.committedHistory.splice(0, Infinity, ...state.history);
    this.committedGaps.splice(0, Infinity, ...state.gaps);
    this.auditEvents.splice(0, Infinity, ...state.audit);
    this.outboxMessages.splice(0, Infinity, ...state.outbox);
  }

  private pilotKey(pilotReference: string, organizationId = ORGANIZATION_ID): string {
    return `${organizationId}:${pilotReference}`;
  }
}

function actor(userId: string, organizationId: string, role: "advisor" | "founder"): ReconstructionActor {
  return { userId, organizationId, role, sessionId: `${role}-session`, capturedSessionVersion: 1, reauthenticatedAtMs: null };
}

function compareOrder(occurredAt: string, sequenceNo: number, previous: ReconstructionHistoryEvent): number {
  const time = Date.parse(occurredAt) - Date.parse(previous.occurredAt);
  return time === 0 ? sequenceNo - previous.sequenceNo : time;
}

function clone(value: Stored): Stored {
  return {
    aggregate: { ...value.aggregate },
    versions: new Map([...value.versions].map(([key, version]) => [key, { ...version }])),
    events: new Map([...value.events].map(([key, events]) => [key, events.map((event) => ({ ...event }))])),
    gaps: new Map([...value.gaps].map(([key, gaps]) => [key, gaps.map((gap) => ({ ...gap }))])),
  };
}

function snapshot(value: Stored, versionId = value.aggregate.currentVersionId): ReconstructionResult {
  const version = value.versions.get(versionId);
  if (!version) throw new ReconstructionError("RECONSTRUCTION_NOT_FOUND");
  return snapshotResult({
    reconstruction: value.aggregate,
    version,
    versions: [...value.versions.values()].sort((left, right) => left.versionNo - right.versionNo),
    events: value.events.get(versionId) ?? [],
    gaps: value.gaps.get(versionId) ?? [],
    metadata: { outcome: "committed", httpStatus: 200, retryable: false, errorCode: null },
  }, "committed");
}

function snapshotResult(value: ReconstructionResult, outcome: "committed" | "replayed"): ReconstructionResult {
  return Object.freeze({
    reconstruction: Object.freeze({ ...value.reconstruction }),
    version: Object.freeze({ ...value.version }),
    versions: Object.freeze(value.versions.map((version) => Object.freeze({ ...version }))),
    events: Object.freeze(value.events.map((event) => Object.freeze({ ...event }))),
    gaps: Object.freeze(value.gaps.map((gap) => Object.freeze({ ...gap }))),
    metadata: Object.freeze({ outcome, httpStatus: 200, retryable: false, errorCode: null }),
  });
}
