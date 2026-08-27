import { randomUUID } from "node:crypto";

import {
  compatibilityRoleForRepository,
  type RequestAccessActor,
} from "../../access/public.ts";
import {
  buildAtomicMutationEffects,
  buildAuditEvent,
  buildOutboxMessage,
  type MutationEffectBundle,
} from "../../audit/public.ts";
import {
  hashRequestPayload,
  validateIdempotencyKey,
} from "../../shared/public.ts";
import { encodeDeletionRequestLocator } from "../domain/deletion-request-locator.ts";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const DELETION_ENTITY_TYPES = Object.freeze([
  "student",
  "guardian",
] as const);
export const PENDING_DELETE_REASON =
  "record.lifecycle.pending_delete_requested" as const;

export type DeletionEntityType = (typeof DELETION_ENTITY_TYPES)[number];

export interface DeletionRequestReceipt {
  readonly entityType: DeletionEntityType;
  readonly entityId: string;
  readonly status: "pending_delete";
  readonly deletionRequestedAt: string;
  readonly recordVersion: number;
}

export interface DeletionRequestSummary extends DeletionRequestReceipt {
  readonly requestId: string;
  readonly displayLabel: string;
}
export interface DeletionRequestQueueItem extends DeletionRequestReceipt {
  readonly displayLabel: string;
}

export interface DecideDeletionCommand {
  readonly entityType: DeletionEntityType;
  readonly entityId: string;
  readonly decision: "approve" | "reject";
  readonly expectedRecordVersion: number;
  readonly correlationRequestId: string;
  readonly idempotencyKey: string;
}
export interface DeletionDecisionResult {
  readonly entityType: DeletionEntityType;
  readonly entityId: string;
  readonly status: "deleted" | "active";
  readonly recordVersion: number;
  readonly occurredAt: string;
}

interface ActorInput {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly actorRole: string;
}

export interface DeletionReviewRepository {
  requestDeletion(
    input: ActorInput & {
      readonly entityType: DeletionEntityType;
      readonly entityId: string;
      readonly expectedRecordVersion: number;
      readonly reasonCode: typeof PENDING_DELETE_REASON;
      readonly idempotencyKey: string;
      readonly requestHash: string;
      readonly effects: MutationEffectBundle;
    },
  ): Promise<DeletionRequestReceipt>;
  listDeletionRequests(
    input: ActorInput & {
      readonly entityType: DeletionEntityType | null;
    },
  ): Promise<readonly DeletionRequestQueueItem[]>;
  decideDeletion(
    input: ActorInput & {
      readonly command: DecideDeletionCommand;
      readonly requestHash: string;
      readonly idempotencyRecordId: string;
      readonly occurredAt: string;
      readonly effects: MutationEffectBundle;
    },
  ): Promise<DeletionDecisionResult>;
}

export type DeletionReviewErrorCode =
  | "DELETION_REVIEW_FORBIDDEN"
  | "DELETION_REVIEW_INVALID"
  | "DELETION_REVIEW_NOT_FOUND"
  | "DELETION_REVIEW_STALE"
  | "DELETION_REVIEW_CONFLICT"
  | "DELETION_REVIEW_IDEMPOTENCY_KEY_REUSED"
  | "DELETION_REVIEW_IDEMPOTENCY_IN_PROGRESS"
  | "DELETION_REVIEW_UNAVAILABLE";

const ERROR_CODES = new Set<DeletionReviewErrorCode>([
  "DELETION_REVIEW_FORBIDDEN",
  "DELETION_REVIEW_INVALID",
  "DELETION_REVIEW_NOT_FOUND",
  "DELETION_REVIEW_STALE",
  "DELETION_REVIEW_CONFLICT",
  "DELETION_REVIEW_UNAVAILABLE",
  "DELETION_REVIEW_IDEMPOTENCY_KEY_REUSED",
  "DELETION_REVIEW_IDEMPOTENCY_IN_PROGRESS",
]);

export class DeletionReviewError extends Error {
  readonly code: DeletionReviewErrorCode;
  constructor(code: DeletionReviewErrorCode) {
    super(`Deletion review rejected ${code}.`);
    this.name = "DeletionReviewError";
    this.code = code;
  }
}

export function isDeletionReviewError(
  value: unknown,
  code?: DeletionReviewErrorCode,
): value is DeletionReviewError {
  if (!(value instanceof Error) || value.name !== "DeletionReviewError")
    return false;
  const candidate = (value as Error & { readonly code?: unknown }).code;
  if (
    typeof candidate !== "string" ||
    !ERROR_CODES.has(candidate as DeletionReviewErrorCode)
  )
    return false;
  return code === undefined || candidate === code;
}

export class DeletionReviewService {
  private readonly repository: DeletionReviewRepository;
  private readonly createId: () => string;
  private readonly now: () => number;

  constructor(
    repository: DeletionReviewRepository,
    createId: () => string = randomUUID,
    now: () => number = Date.now,
  ) {
    this.repository = repository;
    this.createId = createId;
    this.now = now;
  }

  requestDeletion(input: {
    readonly actor: RequestAccessActor;
    readonly command: {
      readonly entityType: DeletionEntityType;
      readonly entityId: string;
      readonly expectedRecordVersion: number;
      readonly reasonCode: typeof PENDING_DELETE_REASON;
      readonly requestId: string;
      readonly idempotencyKey: string;
    };
  }) {
    authorize(input.actor, "students.deletion.request");
    const { command } = input;
    if (
      !isEntityType(command.entityType) ||
      !UUID.test(command.entityId) ||
      !validVersion(command.expectedRecordVersion) ||
      command.reasonCode !== PENDING_DELETE_REASON ||
      !REQUEST_ID.test(command.requestId)
    )
      invalid();
    try {
      validateIdempotencyKey(command.idempotencyKey);
    } catch {
      invalid();
    }
    const entityId = command.entityId.toLowerCase();
    const requestHash = hashRequestPayload({
      entity_type: command.entityType,
      entity_id: entityId,
      expected_record_version: command.expectedRecordVersion,
      reason_code: command.reasonCode,
    });
    return this.repository.requestDeletion(
      actorInput(input.actor, "students.deletion.request", {
        ...command,
        entityId,
        requestHash,
        effects: effects(
          input.actor,
          { ...command, entityId },
          this.createId,
          this.now,
        ),
      }),
    );
  }

  listDeletionRequests(
    actor: RequestAccessActor,
    entityType: DeletionEntityType | null,
  ) {
    authorize(actor, "students.deletion.review");
    if (entityType !== null && !isEntityType(entityType)) invalid();
    return this.repository
      .listDeletionRequests(
        actorInput(actor, "students.deletion.review", { entityType }),
      )
      .then((items) =>
        Object.freeze(
          items.map((item) =>
            Object.freeze({
              ...item,
              requestId: encodeDeletionRequestLocator(
                item.entityType,
                item.entityId,
              ),
            }),
          ),
        ),
      );
  }

  decideDeletion(input: {
    readonly actor: RequestAccessActor;
    readonly command: DecideDeletionCommand;
  }) {
    authorize(input.actor, "students.deletion.review");
    const command = input.command;
    if (
      !isEntityType(command.entityType) ||
      !UUID.test(command.entityId) ||
      !["approve", "reject"].includes(command.decision) ||
      !validVersion(command.expectedRecordVersion) ||
      !REQUEST_ID.test(command.correlationRequestId)
    )
      invalid();
    try {
      validateIdempotencyKey(command.idempotencyKey);
    } catch {
      invalid();
    }
    const entityId = command.entityId.toLowerCase();
    const canonicalCommand = { ...command, entityId };
    const occurredAt = new Date(this.now()).toISOString();
    const ids = [
      newId(this.createId),
      newId(this.createId),
      newId(this.createId),
    ];
    const status = command.decision === "approve" ? "deleted" : "active";
    const approved = command.decision === "approve";
    const eventType = approved
      ? "crm.soft_deletion_approved"
      : "crm.soft_deletion_rejected";
    const reasonCode = approved
      ? "record.lifecycle.soft_deletion_approved"
      : "record.lifecycle.soft_deletion_rejected";
    const metadata = {
      entity_type: command.entityType,
      decision: command.decision,
      previous_version: command.expectedRecordVersion,
      record_version: command.expectedRecordVersion + 1,
      status,
      reason_code: reasonCode,
      request_id: command.correlationRequestId,
    } as const;
    const resourceType =
      command.entityType === "student" ? "Student" : "Guardian";
    const audit = buildAuditEvent({
      id: ids[1]!,
      organizationId: input.actor.organizationId,
      actorUserId: input.actor.userId,
      actorKind: "user",
      eventType,
      eventVersion: 1,
      action: approved ? "approve_soft_deletion" : "reject_soft_deletion",
      resourceType,
      resourceId: entityId,
      outcome: "succeeded",
      requestId: command.correlationRequestId,
      occurredAt,
      metadata,
    });
    const outbox = buildOutboxMessage({
      id: ids[2]!,
      auditEventId: audit.id,
      organizationId: input.actor.organizationId,
      aggregateType: resourceType,
      aggregateId: entityId,
      eventType,
      eventVersion: 1,
      idempotencyKey: `deletion-decision-${ids[0]}`,
      requestId: command.correlationRequestId,
      payload: { aggregate_id: entityId, ...metadata },
      availableAt: occurredAt,
      createdAt: occurredAt,
    });
    return this.repository.decideDeletion(
      actorInput(input.actor, "students.deletion.review", {
        command: canonicalCommand,
        requestHash: hashRequestPayload({
          entity_type: command.entityType,
          entity_id: entityId,
          decision: command.decision,
          expected_record_version: command.expectedRecordVersion,
        }),
        idempotencyRecordId: ids[0]!,
        occurredAt,
        effects: buildAtomicMutationEffects({ audit, outbox }),
      }),
    );
  }
}

function actorInput<T extends object>(
  actor: RequestAccessActor,
  capability: "students.deletion.request" | "students.deletion.review",
  extra: T,
): ActorInput & T {
  const compatibilityRole = compatibilityRoleForRepository(actor, capability);
  if (!compatibilityRole) forbidden();
  return {
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    actorRole: compatibilityRole,
    ...extra,
  };
}
function authorize(
  actor: RequestAccessActor,
  capability: "students.deletion.request" | "students.deletion.review",
) {
  if (
    !UUID.test(actor.organizationId) ||
    !UUID.test(actor.userId) ||
    !compatibilityRoleForRepository(actor, capability)
  )
    forbidden();
}
function isEntityType(value: unknown): value is DeletionEntityType {
  return (DELETION_ENTITY_TYPES as readonly unknown[]).includes(value);
}
function validVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}
function invalid(): never {
  throw new DeletionReviewError("DELETION_REVIEW_INVALID");
}
function forbidden(): never {
  throw new DeletionReviewError("DELETION_REVIEW_FORBIDDEN");
}
function newId(createId: () => string): string {
  const id = createId();
  if (!UUID.test(id)) invalid();
  return id;
}
function effects(
  actor: RequestAccessActor,
  command: {
    readonly entityType: DeletionEntityType;
    readonly entityId: string;
    readonly expectedRecordVersion: number;
    readonly reasonCode: typeof PENDING_DELETE_REASON;
    readonly requestId: string;
  },
  createId: () => string,
  now: () => number,
): MutationEffectBundle {
  const occurredAt = new Date(now()).toISOString();
  const eventType = "crm.soft_deletion_requested";
  const resourceType =
    command.entityType === "student" ? "Student" : "Guardian";
  const metadata = {
    effect_type: "pending_delete_requested",
    previous_version: command.expectedRecordVersion,
    record_version: command.expectedRecordVersion + 1,
    reason_code: command.reasonCode,
    status: "pending_delete",
  } as const;
  const audit = buildAuditEvent({
    id: newId(createId),
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    actorKind: "user",
    eventType,
    eventVersion: 1,
    action: "request_pending_delete",
    resourceType,
    resourceId: command.entityId,
    outcome: "succeeded",
    requestId: command.requestId,
    occurredAt,
    metadata,
  });
  const outbox = buildOutboxMessage({
    id: newId(createId),
    auditEventId: audit.id,
    organizationId: actor.organizationId,
    aggregateType: resourceType,
    aggregateId: command.entityId,
    eventType,
    eventVersion: 1,
    idempotencyKey: `crm-pending-delete-${audit.id}`,
    requestId: command.requestId,
    payload: {
      aggregate_id: command.entityId,
      entity_type: command.entityType,
      effect_type: "pending_delete_requested",
      record_version: command.expectedRecordVersion + 1,
      request_id: command.requestId,
      status: "pending_delete",
    },
    availableAt: occurredAt,
    createdAt: occurredAt,
  });
  return buildAtomicMutationEffects({ audit, outbox });
}
