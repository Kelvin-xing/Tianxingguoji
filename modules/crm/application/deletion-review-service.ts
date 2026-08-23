import { randomUUID } from "node:crypto";

import { evaluateBootstrapAuthorization } from "../../access/public.ts";
import {
  buildAtomicMutationEffects,
  buildAuditEvent,
  buildOutboxMessage,
  type MutationEffectBundle,
} from "../../audit/public.ts";
import type { IdentitySessionActor } from "../../identity/public.ts";
import { hashRequestPayload, validateIdempotencyKey } from "../../shared/public.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const DELETION_ENTITY_TYPES = Object.freeze(["student", "guardian"] as const);
export const PENDING_DELETE_REASON = "record.lifecycle.pending_delete_requested" as const;

export type DeletionEntityType = (typeof DELETION_ENTITY_TYPES)[number];

export interface DeletionRequestReceipt {
  readonly entityType: DeletionEntityType;
  readonly entityId: string;
  readonly status: "pending_delete";
  readonly deletionRequestedAt: string;
  readonly recordVersion: number;
}

export interface DeletionRequestSummary extends DeletionRequestReceipt {
  readonly displayLabel: string;
}

interface ActorInput {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly actorRole: IdentitySessionActor["role"];
}

export interface DeletionReviewRepository {
  requestDeletion(input: ActorInput & {
    readonly entityType: DeletionEntityType;
    readonly entityId: string;
    readonly expectedRecordVersion: number;
    readonly reasonCode: typeof PENDING_DELETE_REASON;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly effects: MutationEffectBundle;
  }): Promise<DeletionRequestReceipt>;
  listDeletionRequests(input: ActorInput & {
    readonly entityType: DeletionEntityType | null;
  }): Promise<readonly DeletionRequestSummary[]>;
}

export type DeletionReviewErrorCode =
  | "DELETION_REVIEW_FORBIDDEN"
  | "DELETION_REVIEW_INVALID"
  | "DELETION_REVIEW_NOT_FOUND"
  | "DELETION_REVIEW_STALE"
  | "DELETION_REVIEW_CONFLICT"
  | "DELETION_REVIEW_UNAVAILABLE";

const ERROR_CODES = new Set<DeletionReviewErrorCode>([
  "DELETION_REVIEW_FORBIDDEN", "DELETION_REVIEW_INVALID", "DELETION_REVIEW_NOT_FOUND",
  "DELETION_REVIEW_STALE", "DELETION_REVIEW_CONFLICT", "DELETION_REVIEW_UNAVAILABLE",
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
  if (!(value instanceof Error) || value.name !== "DeletionReviewError") return false;
  const candidate = (value as Error & { readonly code?: unknown }).code;
  if (typeof candidate !== "string" || !ERROR_CODES.has(candidate as DeletionReviewErrorCode)) return false;
  return code === undefined || candidate === code;
}

export class DeletionReviewService {
  private readonly repository: DeletionReviewRepository;
  private readonly createId: () => string;
  private readonly now: () => number;

  constructor(repository: DeletionReviewRepository, createId: () => string = randomUUID,
    now: () => number = Date.now) {
    this.repository = repository;
    this.createId = createId;
    this.now = now;
  }

  requestDeletion(input: { readonly actor: IdentitySessionActor; readonly command: {
    readonly entityType: DeletionEntityType; readonly entityId: string;
    readonly expectedRecordVersion: number; readonly reasonCode: typeof PENDING_DELETE_REASON;
    readonly requestId: string; readonly idempotencyKey: string;
  } }) {
    authorize(input.actor, "students.deletion.request");
    const { command } = input;
    if (!isEntityType(command.entityType) || !UUID.test(command.entityId) ||
        !validVersion(command.expectedRecordVersion) || command.reasonCode !== PENDING_DELETE_REASON ||
        !REQUEST_ID.test(command.requestId)) invalid();
    try { validateIdempotencyKey(command.idempotencyKey); } catch { invalid(); }
    const requestHash = hashRequestPayload({ entity_type: command.entityType,
      entity_id: command.entityId, expected_record_version: command.expectedRecordVersion,
      reason_code: command.reasonCode });
    return this.repository.requestDeletion(actorInput(input.actor, { ...command, requestHash,
      effects: effects(input.actor, command, this.createId, this.now) }));
  }

  listDeletionRequests(actor: IdentitySessionActor, entityType: DeletionEntityType | null) {
    authorize(actor, "students.deletion.review");
    if (entityType !== null && !isEntityType(entityType)) invalid();
    return this.repository.listDeletionRequests(actorInput(actor, { entityType }));
  }
}

function actorInput<T extends object>(actor: IdentitySessionActor, extra: T): ActorInput & T {
  return { organizationId: actor.organizationId, actorUserId: actor.userId, actorRole: actor.role, ...extra };
}
function authorize(actor: IdentitySessionActor, capability: "students.deletion.request" | "students.deletion.review") {
  if (!UUID.test(actor.organizationId) || !UUID.test(actor.userId) ||
      !evaluateBootstrapAuthorization(actor.role, { capability }).allowed) forbidden();
}
function isEntityType(value: unknown): value is DeletionEntityType {
  return (DELETION_ENTITY_TYPES as readonly unknown[]).includes(value);
}
function validVersion(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 1; }
function invalid(): never { throw new DeletionReviewError("DELETION_REVIEW_INVALID"); }
function forbidden(): never { throw new DeletionReviewError("DELETION_REVIEW_FORBIDDEN"); }
function newId(createId: () => string): string { const id = createId(); if (!UUID.test(id)) invalid(); return id; }
function effects(actor: IdentitySessionActor, command: {
  readonly entityType: DeletionEntityType; readonly entityId: string; readonly expectedRecordVersion: number;
  readonly reasonCode: typeof PENDING_DELETE_REASON; readonly requestId: string;
}, createId: () => string, now: () => number): MutationEffectBundle {
  const occurredAt = new Date(now()).toISOString();
  const eventType = `crm.${command.entityType}_pending_delete_requested`;
  const resourceType = command.entityType === "student" ? "Student" : "Guardian";
  const metadata = { effect_type: "pending_delete_requested",
    previous_version: command.expectedRecordVersion, record_version: command.expectedRecordVersion + 1,
    reason_code: command.reasonCode, status: "pending_delete" } as const;
  const audit = buildAuditEvent({ id: newId(createId), organizationId: actor.organizationId,
    actorUserId: actor.userId, actorKind: "user", eventType, eventVersion: 1,
    action: "request_pending_delete", resourceType, resourceId: command.entityId,
    outcome: "succeeded", requestId: command.requestId, occurredAt, metadata });
  const outbox = buildOutboxMessage({ id: newId(createId), auditEventId: audit.id,
    organizationId: actor.organizationId, aggregateType: resourceType, aggregateId: command.entityId,
    eventType, eventVersion: 1, idempotencyKey: `crm-pending-delete-${audit.id}`,
    requestId: command.requestId, payload: { aggregate_id: command.entityId,
      effect_type: "pending_delete_requested",
      record_version: command.expectedRecordVersion + 1, request_id: command.requestId,
      status: "pending_delete" }, availableAt: occurredAt, createdAt: occurredAt });
  return buildAtomicMutationEffects({ audit, outbox });
}
