import { randomUUID } from "node:crypto";

import {
  buildAtomicMutationEffects,
  buildAuditEvent,
  buildOutboxMessage,
  type MutationEffectBundle,
} from "../../audit/public.ts";
import type { IdentitySessionActor } from "../../identity/public.ts";
import {
  hashRequestPayload,
  validateIdempotencyKey,
  type JsonValue,
} from "../../shared/public.ts";
import {
  evaluateAssessmentFieldAnswer,
  type AnswerSemanticState,
  type AssessmentStatus,
  type K12ManifestComposition,
} from "../domain/contract.ts";
import {
  AssessmentSchemaError,
  getAssessmentSchemaField,
  resolveAssessmentSchema,
  type AssessmentSchemaView,
} from "../domain/schema-resolver.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_CODE = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const SEMANTIC_STATES = new Set<AnswerSemanticState>([
  "provided",
  "unknown",
  "not_applicable",
  "declined_to_provide",
]);

export interface AssessmentClock {
  nowMs(): number;
}

export interface StoredAssessmentAnswer {
  readonly id: string;
  readonly fieldId: string;
  readonly semanticState: AnswerSemanticState;
  readonly value: JsonValue | null;
  readonly valueType: string | null;
  readonly recordVersion: number;
}

export interface AssessmentSnapshot {
  readonly assessmentId: string;
  readonly manifestId: string;
  readonly status: AssessmentStatus;
  readonly manifest: K12ManifestComposition;
  readonly answers: readonly StoredAssessmentAnswer[];
}

export interface AssessmentView {
  readonly assessmentId: string;
  readonly manifestId: string;
  readonly status: AssessmentStatus;
  readonly schema: AssessmentSchemaView;
  readonly answers: readonly AssessmentAnswerView[];
}

export interface AssessmentAnswerView {
  readonly fieldId: string;
  readonly semanticState: AnswerSemanticState;
  readonly value: JsonValue | null;
  readonly valueType: string | null;
  readonly recordVersion: number;
}

export interface UpdateAssessmentAnswerCommand {
  readonly fieldId: string;
  readonly semanticState: AnswerSemanticState;
  readonly value: unknown;
  readonly valueType: string | null;
  readonly expectedRecordVersion: number;
  readonly requestId: string;
  readonly idempotencyKey: string;
}

export interface UpdateAssessmentAnswerResult extends AssessmentAnswerView {
  readonly assessmentId: string;
}

export interface AssessmentRepository {
  /**
   * The production adapter authorizes this read against the current case and
   * collaborator scope before returning its immutable manifest and answers.
   */
  readCaseAssessment(input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly caseId: string;
  }): Promise<AssessmentSnapshot>;
  /**
   * The production adapter must re-read and lock the case, manifest, access
   * capability, answer version, and idempotency row in one RDS transaction
   * before committing answer, audit, and outbox state.
   */
  updateAssessmentAnswer(input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly caseId: string;
    readonly assessmentId: string;
    readonly manifestId: string;
    readonly answerId: string;
    readonly field: AssessmentSchemaView["fields"][number];
    readonly semanticState: AnswerSemanticState;
    readonly value: JsonValue | null;
    readonly valueType: string | null;
    readonly expectedRecordVersion: number;
    readonly requestId: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly updatedAtMs: number;
    readonly effects: MutationEffectBundle;
  }): Promise<UpdateAssessmentAnswerResult>;
}

export type AssessmentServiceErrorCode =
  | "ASSESSMENT_ANSWER_INVALID"
  | "ASSESSMENT_ANSWER_STALE_VERSION"
  | "ASSESSMENT_ANSWER_IDEMPOTENCY_KEY_REUSED"
  | "ASSESSMENT_ANSWER_IDEMPOTENCY_IN_PROGRESS"
  | "ASSESSMENT_CASE_NOT_FOUND"
  | "ASSESSMENT_READ_FORBIDDEN"
  | "ASSESSMENT_WRITE_FORBIDDEN"
  | "ASSESSMENT_SCHEMA_INVALID";

export class AssessmentServiceError extends Error {
  readonly code: AssessmentServiceErrorCode;
  readonly currentRecordVersion: number | null;
  readonly diffToken: string | null;

  constructor(
    code: AssessmentServiceErrorCode,
    options: { readonly currentRecordVersion?: number; readonly diffToken?: string } = {},
  ) {
    super(`Assessment command rejected ${code}.`);
    this.name = "AssessmentServiceError";
    this.code = code;
    this.currentRecordVersion = options.currentRecordVersion ?? null;
    this.diffToken = options.diffToken ?? null;
  }
}

export interface AssessmentServiceOptions {
  readonly repository: AssessmentRepository;
  readonly clock?: AssessmentClock;
  readonly createId?: () => string;
}

/** CaseWorkflow owns assessment answers; routes never author values directly. */
export class AssessmentService {
  private readonly repository: AssessmentRepository;
  private readonly clock: AssessmentClock;
  private readonly createId: () => string;

  constructor(options: AssessmentServiceOptions) {
    this.repository = options.repository;
    this.clock = options.clock ?? { nowMs: () => Date.now() };
    this.createId = options.createId ?? randomUUID;
  }

  async getCaseAssessment(input: {
    readonly actor: IdentitySessionActor;
    readonly caseId: string;
  }): Promise<AssessmentView> {
    assertActorAndCase(input.actor, input.caseId);
    const snapshot = await this.repository.readCaseAssessment({
      organizationId: input.actor.organizationId,
      actorUserId: input.actor.userId,
      caseId: input.caseId,
    });
    return projectAssessment(snapshot);
  }

  async updateAssessmentAnswer(input: {
    readonly actor: IdentitySessionActor;
    readonly caseId: string;
    readonly command: UpdateAssessmentAnswerCommand;
  }): Promise<UpdateAssessmentAnswerResult> {
    assertActorAndCase(input.actor, input.caseId);
    assertCommand(input.command);

    const snapshot = await this.repository.readCaseAssessment({
      organizationId: input.actor.organizationId,
      actorUserId: input.actor.userId,
      caseId: input.caseId,
    });
    let schema: AssessmentSchemaView;
    let field: AssessmentSchemaView["fields"][number];
    try {
      schema = resolveAssessmentSchema({ manifestId: snapshot.manifestId, manifest: snapshot.manifest });
      field = getAssessmentSchemaField(schema, input.command.fieldId);
    } catch (error) {
      if (error instanceof AssessmentSchemaError) {
        throw new AssessmentServiceError(
          error.code === "ASSESSMENT_FIELD_NOT_FOUND"
            ? "ASSESSMENT_ANSWER_INVALID"
            : "ASSESSMENT_SCHEMA_INVALID",
        );
      }
      throw error;
    }

    const value = normalizeAnswerValue(input.command, field);
    const prior = snapshot.answers.find((answer) => answer.fieldId === input.command.fieldId);
    const answerId = prior?.id ?? this.createId();
    const auditId = this.createId();
    const outboxId = this.createId();
    for (const id of [answerId, auditId, outboxId]) assertUuid(id);

    const updatedAtMs = this.clock.nowMs();
    if (!Number.isSafeInteger(updatedAtMs) || updatedAtMs <= 0) {
      throw new AssessmentServiceError("ASSESSMENT_ANSWER_INVALID");
    }
    const occurredAt = new Date(updatedAtMs).toISOString();
    const recordVersion = input.command.expectedRecordVersion + 1;
    const eventType = "cases.assessment_answer_updated";
    const audit = buildAuditEvent({
      id: auditId,
      organizationId: input.actor.organizationId,
      actorUserId: input.actor.userId,
      actorKind: "user",
      eventType,
      eventVersion: 1,
      action: "update",
      resourceType: "AssessmentAnswer",
      resourceId: answerId,
      outcome: "succeeded",
      requestId: input.command.requestId,
      occurredAt,
      beforeHashSha256: prior ? hashAnswer(prior) : null,
      afterHashSha256: hashAnswer({
        semanticState: input.command.semanticState,
        value,
        valueType: input.command.valueType,
      }),
      metadata: {
        effect_type: "assessment_answer_updated",
        record_version: recordVersion,
        status: snapshot.status,
      },
    });
    const outbox = buildOutboxMessage({
      id: outboxId,
      auditEventId: auditId,
      organizationId: input.actor.organizationId,
      aggregateType: "AssessmentAnswer",
      aggregateId: answerId,
      eventType,
      eventVersion: 1,
      idempotencyKey: `assessment-answer-${outboxId}`,
      requestId: input.command.requestId,
      payload: {
        aggregate_id: answerId,
        effect_type: "assessment_answer_updated",
        record_version: recordVersion,
        request_id: input.command.requestId,
        status: snapshot.status,
      },
      availableAt: occurredAt,
      createdAt: occurredAt,
    });

    return this.repository.updateAssessmentAnswer({
      organizationId: input.actor.organizationId,
      actorUserId: input.actor.userId,
      caseId: input.caseId,
      assessmentId: snapshot.assessmentId,
      manifestId: snapshot.manifestId,
      answerId,
      field,
      semanticState: input.command.semanticState,
      value,
      valueType: input.command.valueType,
      expectedRecordVersion: input.command.expectedRecordVersion,
      requestId: input.command.requestId,
      idempotencyKey: input.command.idempotencyKey,
      requestHash: hashRequestPayload({
        caseId: input.caseId,
        expectedRecordVersion: input.command.expectedRecordVersion,
        fieldId: input.command.fieldId,
        semanticState: input.command.semanticState,
        value,
        valueType: input.command.valueType,
      }),
      updatedAtMs,
      effects: buildAtomicMutationEffects({ audit, outbox }),
    });
  }
}

function projectAssessment(snapshot: AssessmentSnapshot): AssessmentView {
  let schema: AssessmentSchemaView;
  try {
    schema = resolveAssessmentSchema({ manifestId: snapshot.manifestId, manifest: snapshot.manifest });
  } catch (error) {
    if (error instanceof AssessmentSchemaError) {
      throw new AssessmentServiceError("ASSESSMENT_SCHEMA_INVALID");
    }
    throw error;
  }

  const answers = snapshot.answers.map((answer) => {
    try {
      const field = getAssessmentSchemaField(schema, answer.fieldId);
      const value = normalizeAnswerValue(answer, field);
      if (!Number.isSafeInteger(answer.recordVersion) || answer.recordVersion < 1) {
        throw new AssessmentServiceError("ASSESSMENT_SCHEMA_INVALID");
      }
      return Object.freeze({
        fieldId: answer.fieldId,
        semanticState: answer.semanticState,
        value,
        valueType: answer.valueType,
        recordVersion: answer.recordVersion,
      });
    } catch (error) {
      if (error instanceof AssessmentServiceError) throw error;
      throw new AssessmentServiceError("ASSESSMENT_SCHEMA_INVALID");
    }
  });

  return Object.freeze({
    assessmentId: snapshot.assessmentId,
    manifestId: snapshot.manifestId,
    status: snapshot.status,
    schema,
    answers: Object.freeze(answers),
  });
}

function assertActorAndCase(actor: IdentitySessionActor, caseId: string): void {
  if (!UUID.test(actor.organizationId) || !UUID.test(actor.userId) || !UUID.test(caseId)) {
    throw new AssessmentServiceError("ASSESSMENT_ANSWER_INVALID");
  }
}

function assertCommand(command: UpdateAssessmentAnswerCommand): void {
  if (
    !SAFE_CODE.test(command.fieldId) ||
    !SEMANTIC_STATES.has(command.semanticState) ||
    !Number.isSafeInteger(command.expectedRecordVersion) ||
    command.expectedRecordVersion < 0 ||
    !SAFE_CODE.test(command.requestId) ||
    (command.valueType !== null && !SAFE_CODE.test(command.valueType))
  ) {
    throw new AssessmentServiceError("ASSESSMENT_ANSWER_INVALID");
  }
  try {
    validateIdempotencyKey(command.idempotencyKey);
  } catch {
    throw new AssessmentServiceError("ASSESSMENT_ANSWER_INVALID");
  }
}

function normalizeAnswerValue(
  input: Pick<UpdateAssessmentAnswerCommand, "semanticState" | "value" | "valueType">,
  field: AssessmentSchemaView["fields"][number],
): JsonValue | null {
  const decision = evaluateAssessmentFieldAnswer({
    field,
    semanticState: input.semanticState,
    value: input.value,
    valueType: input.valueType,
  });
  if (!decision.allowed || !isJsonValue(input.value)) {
    throw new AssessmentServiceError("ASSESSMENT_ANSWER_INVALID");
  }

  if (input.semanticState !== "provided") return null;
  if (!isTypedValue(input.value) || input.value.type !== input.valueType || input.value.value === null) {
    throw new AssessmentServiceError("ASSESSMENT_ANSWER_INVALID");
  }
  return input.value;
}

function isTypedValue(value: JsonValue): value is { readonly type: string; readonly value: JsonValue } {
  return (
    value !== null &&
    !Array.isArray(value) &&
    typeof value === "object" &&
    typeof value.type === "string" &&
    Object.hasOwn(value, "value") &&
    isJsonValue(value.value)
  );
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object") return false;
  return Object.values(value).every(isJsonValue);
}

function hashAnswer(input: {
  readonly semanticState: AnswerSemanticState;
  readonly value: JsonValue | null;
  readonly valueType: string | null;
}): string {
  return hashRequestPayload({
    semanticState: input.semanticState,
    value: input.value,
    valueType: input.valueType,
  });
}

function assertUuid(value: string): void {
  if (!UUID.test(value)) throw new AssessmentServiceError("ASSESSMENT_ANSWER_INVALID");
}
