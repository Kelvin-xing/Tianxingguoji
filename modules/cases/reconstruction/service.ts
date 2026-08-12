import { randomUUID } from "node:crypto";

import {
  buildAtomicMutationEffects,
  buildAuditEvent,
  buildOutboxMessage,
} from "../../audit/contract.ts";
import { hashRequestPayload, validateIdempotencyKey, type JsonValue } from "../../shared/idempotency.ts";
import {
  ReconstructionError,
  type ReconstructionActor,
  type ReconstructionCommandBase,
  type ReconstructionCommandType,
  type ReconstructionCreateCommand,
  type ReconstructionEventInput,
  type ReconstructionGapInput,
  type ReconstructionGapReasonCode,
  type ReconstructionIdempotencyScope,
  type ReconstructionResult,
  type ReconstructionServiceCaseBinding,
} from "./contract.ts";
import { assertOpaqueReference, assertReconstructionEvent, assertReconstructionGap } from "./policy.ts";
import type { CaseReconstructionRepository, ReconstructionWriteContext } from "./repository.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface ReconstructionClock { now(): Date }

export class CaseReconstructionService {
  private readonly repository: CaseReconstructionRepository;
  private readonly clock: ReconstructionClock;
  private readonly createId: () => string;

  constructor(options: {
    readonly repository: CaseReconstructionRepository;
    readonly clock?: ReconstructionClock;
    readonly createId?: () => string;
  }) {
    this.repository = options.repository;
    this.clock = options.clock ?? { now: () => new Date() };
    this.createId = options.createId ?? randomUUID;
  }

  async createDraft(input: {
    readonly actor: ReconstructionActor;
    readonly command: ReconstructionCreateCommand;
  }): Promise<ReconstructionResult> {
    assertAdvisor(input.actor);
    assertCreateCommand(input.command);
    const recordedAt = this.now();
    const reconstructionId = this.id();
    const reconstructionVersionId = this.id();
    const idempotencyScope = this.scope({
      organizationId: input.actor.organizationId,
      actorUserId: input.actor.userId,
      commandType: "create_draft",
      aggregateId: null,
      pilotReference: input.command.pilotReference,
      expectedRecordVersion: null,
      businessPayload: { pilotReference: input.command.pilotReference },
    });
    return this.repository.createDraft({
      organizationId: input.actor.organizationId,
      actor: input.actor,
      reconstructionId,
      reconstructionVersionId,
      requestId: input.command.requestId,
      idempotencyKey: input.command.idempotencyKey,
      command: input.command,
      requestHash: hashRequestPayload(idempotencyScope as unknown as JsonValue),
      idempotencyScope,
      recordedAt,
    });
  }

  async recordEvent(input: {
    readonly actor: ReconstructionActor;
    readonly reconstructionId: string;
    readonly command: ReconstructionCommandBase & { readonly event: ReconstructionEventInput };
  }): Promise<ReconstructionResult> {
    assertAdvisor(input.actor);
    const context = this.context(input.actor, input.reconstructionId, input.command, "record_event", {
      event: input.command.event,
    });
    assertReconstructionEvent(input.command.event, context.recordedAt);
    return this.repository.appendEvent({ ...context, eventId: this.id(), event: input.command.event });
  }

  async recordGap(input: {
    readonly actor: ReconstructionActor;
    readonly reconstructionId: string;
    readonly command: ReconstructionCommandBase & { readonly gap: ReconstructionGapInput };
  }): Promise<ReconstructionResult> {
    assertAdvisor(input.actor);
    const context = this.context(input.actor, input.reconstructionId, input.command, "record_gap", {
      gap: input.command.gap,
    });
    assertReconstructionGap(input.command.gap, context.recordedAt);
    return this.repository.appendGap({ ...context, gapId: this.id(), gap: input.command.gap });
  }

  async submit(input: CommandInput): Promise<ReconstructionResult> {
    assertAdvisor(input.actor);
    return this.repository.submit(this.context(input.actor, input.reconstructionId, input.command, "submit", {}));
  }

  async requestChanges(input: CommandInput): Promise<ReconstructionResult> {
    assertFounder(input.actor);
    return this.repository.requestChanges(
      this.context(input.actor, input.reconstructionId, input.command, "request_changes", {}),
    );
  }

  async createNextDraft(input: CommandInput): Promise<ReconstructionResult> {
    assertAdvisor(input.actor);
    return this.repository.createNextDraft({
      ...this.context(input.actor, input.reconstructionId, input.command, "create_next_draft", {}),
      nextReconstructionVersionId: this.id(),
    });
  }

  async approve(input: CommandInput): Promise<ReconstructionResult> {
    assertFounder(input.actor);
    return this.repository.approve(this.context(input.actor, input.reconstructionId, input.command, "approve", {}));
  }

  async activate(input: CommandInput & {
    readonly serviceCaseBinding?: ReconstructionServiceCaseBinding | null;
  }): Promise<ReconstructionResult> {
    assertFounder(input.actor);
    const serviceCaseBinding = input.serviceCaseBinding ?? null;
    assertActivationBinding(input.actor, serviceCaseBinding);
    const context = this.context(input.actor, input.reconstructionId, input.command, "activate", {
      serviceCaseBinding: serviceCaseBinding
        ? { organizationId: serviceCaseBinding.organizationId, serviceCaseId: serviceCaseBinding.serviceCaseId }
        : null,
    });
    const auditId = this.id();
    const outboxId = this.id();
    const eventType = "case_reconstruction.activated.v1";
    const audit = buildAuditEvent({
      id: auditId,
      organizationId: input.actor.organizationId,
      actorUserId: input.actor.userId,
      actorKind: "user",
      eventType,
      eventVersion: 1,
      action: "activate",
      resourceType: "CaseReconstruction",
      resourceId: input.reconstructionId,
      outcome: "succeeded",
      requestId: input.command.requestId,
      occurredAt: context.recordedAt,
      metadata: { record_version: input.command.expectedRecordVersion + 1, status: "activated" },
    });
    const outbox = buildOutboxMessage({
      id: outboxId,
      auditEventId: auditId,
      organizationId: input.actor.organizationId,
      aggregateType: "CaseReconstruction",
      aggregateId: input.reconstructionId,
      eventType,
      eventVersion: 1,
      idempotencyKey: `reconstruction-activate-${outboxId}`,
      requestId: input.command.requestId,
      payload: {
        aggregate_id: input.reconstructionId,
        record_version: input.command.expectedRecordVersion + 1,
        request_id: input.command.requestId,
        effect_type: eventType,
        status: "activated",
      },
      availableAt: context.recordedAt,
      createdAt: context.recordedAt,
    });
    return this.repository.activate({
      organizationId: context.organizationId,
      actor: context.actor,
      reconstructionId: context.reconstructionId,
      expectedRecordVersion: context.expectedRecordVersion,
      requestId: context.requestId,
      idempotencyKey: context.idempotencyKey,
      requestHash: context.requestHash,
      idempotencyScope: context.idempotencyScope,
      activatedAt: context.recordedAt,
      serviceCaseBinding,
      effects: buildAtomicMutationEffects({ audit, outbox }),
    });
  }

  async appendCorrection(input: {
    readonly actor: ReconstructionActor;
    readonly reconstructionId: string;
    readonly command: ReconstructionCommandBase & {
      readonly correctionOfEventId: string;
      readonly reasonCode: ReconstructionGapReasonCode;
      readonly event: ReconstructionEventInput;
    };
  }): Promise<ReconstructionResult> {
    assertAdvisor(input.actor);
    const context = this.context(input.actor, input.reconstructionId, input.command, "append_correction", {
      correctionOfEventId: input.command.correctionOfEventId,
      reasonCode: input.command.reasonCode,
      event: input.command.event,
    });
    assertUuid(input.command.correctionOfEventId);
    if (!input.command.reasonCode) throw new ReconstructionError("RECONSTRUCTION_INVALID_INPUT");
    assertReconstructionEvent(input.command.event, context.recordedAt);
    const audit = buildAuditEvent({
      id: this.id(),
      organizationId: input.actor.organizationId,
      actorUserId: input.actor.userId,
      actorKind: "user",
      eventType: "case_reconstruction.corrected.v1",
      eventVersion: 1,
      action: "correct",
      resourceType: "CaseReconstruction",
      resourceId: input.reconstructionId,
      outcome: "succeeded",
      requestId: input.command.requestId,
      occurredAt: context.recordedAt,
      metadata: {
        record_version: input.command.expectedRecordVersion + 1,
        reason_code: input.command.reasonCode,
        status: "corrected",
      },
    });
    return this.repository.appendCorrection({
      ...context,
      correctionId: this.id(),
      correctionOfEventId: input.command.correctionOfEventId,
      reasonCode: input.command.reasonCode,
      event: input.command.event,
      audit,
    });
  }

  private context(
    actor: ReconstructionActor,
    reconstructionId: string,
    command: ReconstructionCommandBase,
    commandType: ReconstructionCommandType,
    businessPayload: JsonValue,
  ): ReconstructionWriteContext {
    assertUuid(reconstructionId);
    assertCommand(command);
    const recordedAt = this.now();
    const idempotencyScope = this.scope({
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      commandType,
      aggregateId: reconstructionId,
      pilotReference: null,
      expectedRecordVersion: command.expectedRecordVersion,
      businessPayload,
    });
    return {
      organizationId: actor.organizationId,
      actor,
      reconstructionId,
      expectedRecordVersion: command.expectedRecordVersion,
      requestId: command.requestId,
      idempotencyKey: command.idempotencyKey,
      requestHash: hashRequestPayload(idempotencyScope as unknown as JsonValue),
      idempotencyScope,
      recordedAt,
    };
  }

  private scope(input: ReconstructionIdempotencyScope): ReconstructionIdempotencyScope {
    return {
      ...input,
      businessPayload: normalizeJson(input.businessPayload),
    };
  }

  private now(): string {
    const date = this.clock.now();
    if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
      throw new ReconstructionError("RECONSTRUCTION_INVALID_INPUT");
    }
    return date.toISOString();
  }

  private id(): string {
    const value = this.createId();
    assertUuid(value);
    return value;
  }
}

interface CommandInput {
  readonly actor: ReconstructionActor;
  readonly reconstructionId: string;
  readonly command: ReconstructionCommandBase;
}

function assertAdvisor(actor: ReconstructionActor): void {
  assertActor(actor);
  if (actor.role !== "advisor") throw new ReconstructionError("RECONSTRUCTION_ADVISOR_REQUIRED");
}

function assertFounder(actor: ReconstructionActor): void {
  assertActor(actor);
  if (actor.role !== "founder") throw new ReconstructionError("RECONSTRUCTION_FOUNDER_REQUIRED");
}

function assertActor(actor: ReconstructionActor): void {
  if (!UUID.test(actor.userId) || !UUID.test(actor.organizationId)) {
    throw new ReconstructionError("RECONSTRUCTION_INVALID_INPUT");
  }
}

function assertCreateCommand(command: ReconstructionCreateCommand): void {
  assertOpaqueReference(command.pilotReference);
  assertBase(command.requestId, command.idempotencyKey);
}

function assertCommand(command: ReconstructionCommandBase): void {
  if (!Number.isSafeInteger(command.expectedRecordVersion) || command.expectedRecordVersion < 1) {
    throw new ReconstructionError("RECONSTRUCTION_INVALID_INPUT");
  }
  assertBase(command.requestId, command.idempotencyKey);
}

function assertBase(requestId: string, idempotencyKey: string): void {
  if (!REQUEST_ID.test(requestId)) throw new ReconstructionError("RECONSTRUCTION_INVALID_INPUT");
  try { validateIdempotencyKey(idempotencyKey); } catch {
    throw new ReconstructionError("RECONSTRUCTION_INVALID_INPUT");
  }
}

function assertActivationBinding(
  actor: ReconstructionActor,
  binding: ReconstructionServiceCaseBinding | null,
): void {
  if (binding === null) return;
  if (binding.organizationId !== actor.organizationId || !UUID.test(binding.serviceCaseId)) {
    throw new ReconstructionError("RECONSTRUCTION_INVALID_INPUT");
  }
}

function assertUuid(value: string): void {
  if (!UUID.test(value)) throw new ReconstructionError("RECONSTRUCTION_INVALID_INPUT");
}

function normalizeJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, nested]) => nested !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, normalizeJson(nested as JsonValue)]),
    ) as JsonValue;
  }
  return value;
}
