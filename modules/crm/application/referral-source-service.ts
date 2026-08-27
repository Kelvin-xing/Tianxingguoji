import { randomUUID } from "node:crypto";

import {
  compatibilityRoleForRepository,
  type RequestAccessActor,
  type WorkspaceCapability,
} from "../../access/public.ts";
import {
  buildAtomicMutationEffects,
  buildAuditEvent,
  buildOutboxMessage,
  type MutationEffectBundle,
} from "../../audit/public.ts";
import { hashRequestPayload, validateIdempotencyKey } from "../../shared/public.ts";
import {
  REFERRAL_SOURCE_STATUSES,
  REFERRAL_SOURCE_TYPES,
  type ReferralSourceStatus,
  type ReferralSourceType,
} from "../domain/referral-source-contract.ts";
import { validateReferralSourceDescription } from "../domain/approved-p2-contract.ts";
import {
  decodeReferralSourceCursor,
  encodeReferralSourceCursor,
  type ReferralSourceCursor,
} from "../domain/referral-source-cursor.ts";

export { REFERRAL_SOURCE_STATUSES, REFERRAL_SOURCE_TYPES } from "../domain/referral-source-contract.ts";
export type { ReferralSourceStatus, ReferralSourceType } from "../domain/referral-source-contract.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const REFERRAL_SOURCE_DEACTIVATE_REASON = "record.lifecycle.referral_source_deactivated" as const;

export interface ReferralSourceView {
  readonly id: string;
  readonly displayName: string;
  readonly sourceType: ReferralSourceType;
  readonly description: string | null;
  readonly status: ReferralSourceStatus;
  readonly recordVersion: number;
  readonly updatedAt: string;
}

export interface ReferralSourceAcknowledgement {
  readonly id: string;
  readonly status: ReferralSourceStatus;
  readonly recordVersion: number;
  readonly updatedAt: string;
}

export interface ReferralSourceListResult {
  readonly items: readonly ReferralSourceView[];
  readonly nextCursor: string | null;
}

interface ActorInput {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly actorRole: string;
}

export interface ReferralSourceRepository {
  list(input: ActorInput & {
    readonly query: string | null;
    readonly status: ReferralSourceStatus | null;
    readonly sourceType: ReferralSourceType | null;
    readonly limit: number;
    readonly cursor: ReferralSourceCursor | null;
  }): Promise<Readonly<{ items: readonly ReferralSourceView[]; hasMore: boolean }>>;
  find(input: ActorInput & { readonly sourceId: string }): Promise<ReferralSourceView | null>;
  create(input: ActorInput & {
    readonly sourceId: string;
    readonly displayName: string;
    readonly sourceType: ReferralSourceType;
    readonly description?: string | null;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly effects: MutationEffectBundle;
    readonly idempotencyRecordId: string;
    readonly occurredAt: string;
    readonly requestId: string;
  }): Promise<ReferralSourceAcknowledgement>;
  update(input: ActorInput & {
    readonly sourceId: string;
    readonly expectedRecordVersion: number;
    readonly displayName: string;
    readonly sourceType: ReferralSourceType;
    readonly description: string | null;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly effects: MutationEffectBundle;
    readonly idempotencyRecordId: string;
    readonly occurredAt: string;
    readonly requestId: string;
  }): Promise<ReferralSourceAcknowledgement>;
  deactivate(input: ActorInput & {
    readonly sourceId: string;
    readonly expectedRecordVersion: number;
    readonly reasonCode: "record.lifecycle.referral_source_deactivated";
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly effects: MutationEffectBundle;
    readonly idempotencyRecordId: string;
    readonly occurredAt: string;
    readonly requestId: string;
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

  list(actor: RequestAccessActor, filters: {
    readonly query?: string | null;
    readonly status?: ReferralSourceStatus | null;
    readonly sourceType?: ReferralSourceType | null;
    readonly limit?: number;
    readonly cursor?: string | null;
  } | ReferralSourceStatus | null = null) {
    const input = authorize(actor, "referral_sources.read");
    const normalized = typeof filters === "string" || filters === null
      ? { status: filters }
      : filters;
    const status = normalized.status ?? null;
    const sourceType = normalized.sourceType ?? null;
    const query = normalized.query?.trim() || null;
    const limit = normalized.limit ?? 25;
    let cursor: ReferralSourceCursor | null = null;
    if (normalized.cursor !== undefined && normalized.cursor !== null) {
      try {
        cursor = decodeReferralSourceCursor(normalized.cursor);
      } catch {
        invalid();
      }
    }
    if (status !== null && !isStatus(status)) invalid();
    if (sourceType !== null && !isType(sourceType)) invalid();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) invalid();
    if (query !== null && query.length > 200) invalid();
    const effectiveStatus = input.actorRole === "advisor" ? "active" : status;
    const filterHash = hashRequestPayload({
      organization_id: input.organizationId,
      q: query,
      status: effectiveStatus,
      source_type: sourceType,
      sort: "display_name_c_id",
    });
    if (cursor !== null && cursor.filterHash !== filterHash) invalid();
    return this.repository.list({ ...input, query, status: effectiveStatus, sourceType, limit, cursor })
      .then(({ items, hasMore }) => Object.freeze({
        items: Object.freeze([...items]),
        nextCursor: hasMore && items.length > 0
          ? encodeReferralSourceCursor({
            displayName: items[items.length - 1]!.displayName,
            id: items[items.length - 1]!.id,
            filterHash,
          })
          : null,
      }));
  }

  find(actor: RequestAccessActor, sourceId: string) {
    const input = authorize(actor, "referral_sources.read");
    if (!UUID.test(sourceId)) invalid();
    return this.repository.find({ ...input, sourceId: sourceId.toLowerCase() }).then((source) => {
      if (!source) notFound();
      return source;
    });
  }

  create(input: { readonly actor: RequestAccessActor; readonly command: {
    readonly displayName: string;
    readonly sourceType: ReferralSourceType;
    readonly description?: string | null;
    readonly requestId: string;
    readonly idempotencyKey: string;
  } }) {
    const actor = authorize(input.actor, "referral_sources.manage");
    const displayName = normalizeDisplayName(input.command.displayName);
    const description = normalizeDescription(input.command.description);
    if (!isType(input.command.sourceType) || !validateReferralSourceDescription({
      sourceType: input.command.sourceType, description,
    })) invalid();
    assertWriteMetadata(input.command.requestId, input.command.idempotencyKey);
    const sourceId = checkedId(this.createId);
    const occurredAt = new Date(this.now()).toISOString();
    return this.repository.create({
      ...actor,
      sourceId,
      displayName,
      sourceType: input.command.sourceType,
      description,
      idempotencyKey: input.command.idempotencyKey,
      requestHash: hashRequestPayload({ description, display_name: displayName,
        source_type: input.command.sourceType }),
      effects: effects(input.actor, sourceId, "created", 1, input.command.requestId, this.createId, this.now),
      idempotencyRecordId: checkedId(this.createId),
      occurredAt,
      requestId: input.command.requestId,
    });
  }

  update(input: { readonly actor: RequestAccessActor; readonly command: {
    readonly sourceId: string;
    readonly expectedRecordVersion: number;
    readonly displayName: string;
    readonly sourceType: ReferralSourceType;
    readonly description: string | null;
    readonly requestId: string;
    readonly idempotencyKey: string;
  } }) {
    const actor = authorize(input.actor, "referral_sources.manage");
    const displayName = normalizeDisplayName(input.command.displayName);
    const description = normalizeDescription(input.command.description);
    if (!UUID.test(input.command.sourceId) || !validVersion(input.command.expectedRecordVersion) ||
        !isType(input.command.sourceType)) invalid();
    if (!validateReferralSourceDescription({ sourceType: input.command.sourceType, description })) invalid();
    assertWriteMetadata(input.command.requestId, input.command.idempotencyKey);
    const occurredAt = new Date(this.now()).toISOString();
    return this.repository.update({
      ...actor,
      sourceId: input.command.sourceId,
      expectedRecordVersion: input.command.expectedRecordVersion,
      displayName,
      sourceType: input.command.sourceType,
      description,
      idempotencyKey: input.command.idempotencyKey,
      requestHash: hashRequestPayload({
        display_name: displayName,
        description,
        expected_record_version: input.command.expectedRecordVersion,
        source_id: input.command.sourceId,
        source_type: input.command.sourceType,
      }),
      effects: effects(input.actor, input.command.sourceId, "updated",
        input.command.expectedRecordVersion + 1, input.command.requestId, this.createId, this.now),
      idempotencyRecordId: checkedId(this.createId),
      occurredAt,
      requestId: input.command.requestId,
    });
  }

  deactivate(input: { readonly actor: RequestAccessActor; readonly command: {
    readonly sourceId: string;
    readonly expectedRecordVersion: number;
    readonly reasonCode: typeof REFERRAL_SOURCE_DEACTIVATE_REASON;
    readonly requestId: string;
    readonly idempotencyKey: string;
  } }) {
    const actor = authorize(input.actor, "referral_sources.manage");
    if (!UUID.test(input.command.sourceId) ||
        !validVersion(input.command.expectedRecordVersion) ||
        input.command.reasonCode !== REFERRAL_SOURCE_DEACTIVATE_REASON) invalid();
    assertWriteMetadata(input.command.requestId, input.command.idempotencyKey);
    const sourceId = input.command.sourceId.toLowerCase();
    const occurredAt = new Date(this.now()).toISOString();
    return this.repository.deactivate({
      ...actor,
      sourceId,
      expectedRecordVersion: input.command.expectedRecordVersion,
      reasonCode: REFERRAL_SOURCE_DEACTIVATE_REASON,
      idempotencyKey: input.command.idempotencyKey,
      requestHash: hashRequestPayload({
        expected_record_version: input.command.expectedRecordVersion,
        reason_code: REFERRAL_SOURCE_DEACTIVATE_REASON,
        source_id: sourceId,
      }),
      effects: effects(input.actor, sourceId, "deactivated",
        input.command.expectedRecordVersion + 1, input.command.requestId, this.createId, this.now),
      idempotencyRecordId: checkedId(this.createId),
      occurredAt,
      requestId: input.command.requestId,
    });
  }
}

function authorize(actor: RequestAccessActor, capability: WorkspaceCapability): ActorInput {
  const compatibilityRole = compatibilityRoleForRepository(actor, capability);
  if (!UUID.test(actor.organizationId) || !UUID.test(actor.userId) || !compatibilityRole) forbidden();
  return { organizationId: actor.organizationId, actorUserId: actor.userId,
    actorRole: compatibilityRole };
}

function effects(actor: RequestAccessActor, sourceId: string, effectType: "created" | "updated" | "deactivated",
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
function normalizeDescription(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") invalid();
  const normalized = value.trim();
  if (!normalized || normalized.length > 1000) invalid();
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
function notFound(): never { throw new ReferralSourceError("REFERRAL_SOURCE_NOT_FOUND"); }
