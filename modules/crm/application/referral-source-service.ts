import { randomUUID } from "node:crypto";

import { evaluateBootstrapAuthorization, type WorkspaceCapability } from "../../access/public.ts";
import {
  buildAtomicMutationEffects,
  buildAuditEvent,
  buildOutboxMessage,
  type MutationEffectBundle,
} from "../../audit/public.ts";
import type { IdentitySessionActor } from "../../identity/public.ts";
import { hashRequestPayload, validateIdempotencyKey } from "../../shared/public.ts";
import {
  REFERRAL_SOURCE_STATUSES,
  REFERRAL_SOURCE_TYPES,
  type ReferralSourceStatus,
  type ReferralSourceType,
} from "../domain/referral-source-contract.ts";

export { REFERRAL_SOURCE_STATUSES, REFERRAL_SOURCE_TYPES } from "../domain/referral-source-contract.ts";
export type { ReferralSourceStatus, ReferralSourceType } from "../domain/referral-source-contract.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface ReferralSourceView {
  readonly id: string;
  readonly displayName: string;
  readonly sourceType: ReferralSourceType;
  readonly status: ReferralSourceStatus;
  readonly recordVersion: number;
}

export interface ReferralSourceAcknowledgement {
  readonly id: string;
  readonly recordVersion: number;
}

interface ActorInput {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly actorRole: IdentitySessionActor["role"];
}

export interface ReferralSourceRepository {
  list(input: ActorInput & { readonly status: ReferralSourceStatus | null }): Promise<readonly ReferralSourceView[]>;
  find(input: ActorInput & { readonly sourceId: string }): Promise<ReferralSourceView | null>;
  create(input: ActorInput & {
    readonly sourceId: string;
    readonly displayName: string;
    readonly sourceType: ReferralSourceType;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly effects: MutationEffectBundle;
  }): Promise<ReferralSourceAcknowledgement>;
  update(input: ActorInput & {
    readonly sourceId: string;
    readonly expectedRecordVersion: number;
    readonly displayName: string;
    readonly status: ReferralSourceStatus;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly effects: MutationEffectBundle;
  }): Promise<ReferralSourceAcknowledgement>;
}

export type ReferralSourceErrorCode =
  | "REFERRAL_SOURCE_FORBIDDEN"
  | "REFERRAL_SOURCE_INVALID"
  | "REFERRAL_SOURCE_NOT_FOUND"
  | "REFERRAL_SOURCE_STALE"
  | "REFERRAL_SOURCE_CONFLICT"
  | "REFERRAL_SOURCE_UNAVAILABLE";

const ERROR_CODES = new Set<ReferralSourceErrorCode>([
  "REFERRAL_SOURCE_FORBIDDEN",
  "REFERRAL_SOURCE_INVALID",
  "REFERRAL_SOURCE_NOT_FOUND",
  "REFERRAL_SOURCE_STALE",
  "REFERRAL_SOURCE_CONFLICT",
  "REFERRAL_SOURCE_UNAVAILABLE",
]);

export class ReferralSourceError extends Error {
  readonly code: ReferralSourceErrorCode;
  constructor(code: ReferralSourceErrorCode) {
    super(`Referral source rejected ${code}.`);
    this.name = "ReferralSourceError";
    this.code = code;
  }
}

export function isReferralSourceError(value: unknown, code?: ReferralSourceErrorCode): value is ReferralSourceError {
  if (!(value instanceof Error) || value.name !== "ReferralSourceError") return false;
  const candidate = (value as Error & { readonly code?: unknown }).code;
  if (typeof candidate !== "string" || !ERROR_CODES.has(candidate as ReferralSourceErrorCode)) return false;
  return code === undefined || candidate === code;
}

export class ReferralSourceService {
  private readonly repository: ReferralSourceRepository;
  private readonly createId: () => string;
  private readonly now: () => number;
  constructor(
    repository: ReferralSourceRepository,
    createId: () => string = randomUUID,
    now: () => number = Date.now,
  ) { this.repository = repository; this.createId = createId; this.now = now; }

  list(actor: IdentitySessionActor, status: ReferralSourceStatus | null) {
    const input = authorize(actor, "referral_sources.read");
    if (status !== null && !isStatus(status)) invalid();
    return this.repository.list({ ...input, status });
  }

  find(actor: IdentitySessionActor, sourceId: string) {
    const input = authorize(actor, "referral_sources.read");
    if (!UUID.test(sourceId)) invalid();
    return this.repository.find({ ...input, sourceId });
  }

  create(input: { readonly actor: IdentitySessionActor; readonly command: {
    readonly displayName: string;
    readonly sourceType: ReferralSourceType;
    readonly requestId: string;
    readonly idempotencyKey: string;
  } }) {
    const actor = authorize(input.actor, "referral_sources.manage");
    const displayName = normalizeDisplayName(input.command.displayName);
    if (!isType(input.command.sourceType)) invalid();
    assertWriteMetadata(input.command.requestId, input.command.idempotencyKey);
    const sourceId = checkedId(this.createId);
    return this.repository.create({
      ...actor,
      sourceId,
      displayName,
      sourceType: input.command.sourceType,
      idempotencyKey: input.command.idempotencyKey,
      requestHash: hashRequestPayload({ display_name: displayName, source_type: input.command.sourceType }),
      effects: effects(input.actor, sourceId, "created", 1, input.command.requestId, this.createId, this.now),
    });
  }

  update(input: { readonly actor: IdentitySessionActor; readonly command: {
    readonly sourceId: string;
    readonly expectedRecordVersion: number;
    readonly displayName: string;
    readonly status: ReferralSourceStatus;
    readonly requestId: string;
    readonly idempotencyKey: string;
  } }) {
    const actor = authorize(input.actor, "referral_sources.manage");
    const displayName = normalizeDisplayName(input.command.displayName);
    if (!UUID.test(input.command.sourceId) || !validVersion(input.command.expectedRecordVersion) ||
        !isStatus(input.command.status)) invalid();
    assertWriteMetadata(input.command.requestId, input.command.idempotencyKey);
    return this.repository.update({
      ...actor,
      sourceId: input.command.sourceId,
      expectedRecordVersion: input.command.expectedRecordVersion,
      displayName,
      status: input.command.status,
      idempotencyKey: input.command.idempotencyKey,
      requestHash: hashRequestPayload({
        display_name: displayName,
        expected_record_version: input.command.expectedRecordVersion,
        source_id: input.command.sourceId,
        status: input.command.status,
      }),
      effects: effects(input.actor, input.command.sourceId, "updated",
        input.command.expectedRecordVersion + 1, input.command.requestId, this.createId, this.now),
    });
  }
}

function authorize(actor: IdentitySessionActor, capability: WorkspaceCapability): ActorInput {
  if (!UUID.test(actor.organizationId) || !UUID.test(actor.userId) ||
      !evaluateBootstrapAuthorization(actor.role, { capability }).allowed) forbidden();
  return { organizationId: actor.organizationId, actorUserId: actor.userId, actorRole: actor.role };
}

function effects(actor: IdentitySessionActor, sourceId: string, effectType: "created" | "updated",
  recordVersion: number, requestId: string, createId: () => string, now: () => number): MutationEffectBundle {
  const occurredAt = new Date(now()).toISOString();
  const auditId = checkedId(createId);
  const eventType = `crm.referral_source_${effectType}`;
  const audit = buildAuditEvent({
    id: auditId, organizationId: actor.organizationId, actorUserId: actor.userId,
    actorKind: "user", eventType, eventVersion: 1, action: effectType,
    resourceType: "ReferralSource", resourceId: sourceId, outcome: "succeeded", requestId,
    occurredAt, metadata: { effect_type: `referral_source.${effectType}`, record_version: recordVersion },
  });
  const outbox = buildOutboxMessage({
    id: checkedId(createId), auditEventId: auditId, organizationId: actor.organizationId,
    aggregateType: "ReferralSource", aggregateId: sourceId, eventType, eventVersion: 1,
    idempotencyKey: `referral-source-${effectType}-${auditId}`, requestId,
    payload: { aggregate_id: sourceId, effect_type: `referral_source.${effectType}`,
      record_version: recordVersion, request_id: requestId }, availableAt: occurredAt, createdAt: occurredAt,
  });
  return buildAtomicMutationEffects({ audit, outbox });
}

function normalizeDisplayName(value: unknown): string {
  if (typeof value !== "string") invalid();
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 200) invalid();
  return normalized;
}
function assertWriteMetadata(requestId: string, key: string) {
  if (!REQUEST_ID.test(requestId)) invalid();
  try { validateIdempotencyKey(key); } catch { invalid(); }
}
function checkedId(createId: () => string) { const id = createId(); if (!UUID.test(id)) invalid(); return id; }
function validVersion(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 1; }
function isType(value: unknown): value is ReferralSourceType {
  return (REFERRAL_SOURCE_TYPES as readonly unknown[]).includes(value);
}
function isStatus(value: unknown): value is ReferralSourceStatus {
  return (REFERRAL_SOURCE_STATUSES as readonly unknown[]).includes(value);
}
function invalid(): never { throw new ReferralSourceError("REFERRAL_SOURCE_INVALID"); }
function forbidden(): never { throw new ReferralSourceError("REFERRAL_SOURCE_FORBIDDEN"); }
