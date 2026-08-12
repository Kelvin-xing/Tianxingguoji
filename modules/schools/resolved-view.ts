import { randomUUID } from "node:crypto";

import {
  buildAtomicMutationEffects,
  buildAuditEvent,
  buildOutboxMessage,
  type MutationEffectBundle,
} from "../audit/contract.ts";
import type { IdentitySessionActor } from "../identity/session-repository.ts";
import { hashRequestPayload, validateIdempotencyKey } from "../shared/idempotency.ts";
import {
  type SchoolBaseRecord,
  type SchoolOverlayRevision,
  type SchoolResolutionProvenance,
} from "./contract.ts";
import { resolveSchoolView, type ResolvedSchoolView } from "./resolver.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface SchoolResolutionClock {
  nowMs(): number;
}

export interface SchoolResolutionSource {
  readonly base: SchoolBaseRecord;
  readonly revisions: readonly SchoolOverlayRevision[];
  readonly resolvedRevisionId?: string | null;
}

/** Immutable facts that a SchoolTarget stores instead of a mutable pointer. */
export interface ResolvedSchoolPin {
  readonly resolvedRevisionId: string | null;
  readonly baseSnapshotId: string;
  readonly overlayRevisionId: string | null;
  readonly resolutionSha256: string;
  readonly provenance: Readonly<Record<string, SchoolResolutionProvenance>>;
}

export interface ResolvedSchoolTargetView {
  readonly view: ResolvedSchoolView;
  readonly pin: ResolvedSchoolPin;
}

export interface DisableSchoolOverlayCommand {
  readonly expectedRecordVersion: number;
  readonly reason: string;
  readonly requestId: string;
  readonly idempotencyKey: string;
}

export interface DisableSchoolOverlayResult {
  readonly overlayRevisionId: string;
  readonly recordVersion: number;
  readonly rollback: ResolvedSchoolTargetView;
}

export interface ResolvedSchoolViewRepository {
  /** Authorizes the school read and returns immutable snapshot/revision facts. */
  readResolvedSchool(input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly schoolId: string;
  }): Promise<SchoolResolutionSource>;

  /**
   * Production implementations must authorize the reviewer, lock the overlay
   * receipt and current resolver inputs, enforce the version/idempotency
   * checks, append the disabled receipt and rollback resolved revision, then
   * atomically append audit/outbox facts.
   */
  disableApprovedOverlay(input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly actorRole: "founder" | "data_reviewer";
    readonly schoolId: string;
    readonly overlayRevisionId: string;
    readonly rollbackResolvedRevisionId: string;
    readonly expectedRecordVersion: number;
    readonly reason: string;
    readonly requestId: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly disabledAtMs: number;
    readonly effects: MutationEffectBundle;
  }): Promise<DisableSchoolOverlayResult>;
}

export type SchoolResolutionErrorCode =
  | "SCHOOL_RESOLUTION_INVALID"
  | "SCHOOL_RESOLUTION_NOT_FOUND"
  | "SCHOOL_RESOLUTION_FORBIDDEN"
  | "SCHOOL_OVERLAY_REVIEWER_REQUIRED"
  | "SCHOOL_OVERLAY_NOT_APPROVED"
  | "SCHOOL_OVERLAY_SELF_REVIEW_DENIED"
  | "SCHOOL_OVERLAY_STALE_VERSION"
  | "SCHOOL_OVERLAY_IDEMPOTENCY_KEY_REUSED"
  | "SCHOOL_OVERLAY_IDEMPOTENCY_IN_PROGRESS";

export class SchoolResolutionError extends Error {
  readonly code: SchoolResolutionErrorCode;

  constructor(code: SchoolResolutionErrorCode) {
    super(`School resolution rejected ${code}.`);
    this.name = "SchoolResolutionError";
    this.code = code;
  }
}

export interface ResolvedSchoolViewServiceOptions {
  readonly repository: ResolvedSchoolViewRepository;
  readonly clock?: SchoolResolutionClock;
  readonly createId?: () => string;
}

/**
 * SchoolIntelligence owns the current resolved view and immutable overlay
 * disable receipts. A target pin is always derived from the P0-08 reducer.
 */
export class ResolvedSchoolViewService {
  private readonly repository: ResolvedSchoolViewRepository;
  private readonly clock: SchoolResolutionClock;
  private readonly createId: () => string;

  constructor(options: ResolvedSchoolViewServiceOptions) {
    this.repository = options.repository;
    this.clock = options.clock ?? { nowMs: () => Date.now() };
    this.createId = options.createId ?? randomUUID;
  }

  async getResolvedSchool(input: {
    readonly actor: IdentitySessionActor;
    readonly schoolId: string;
  }): Promise<ResolvedSchoolTargetView> {
    assertReadableActor(input.actor);
    assertUuid(input.schoolId);
    const source = await this.repository.readResolvedSchool({
      organizationId: input.actor.organizationId,
      actorUserId: input.actor.userId,
      schoolId: input.schoolId,
    });
    return resolveSchoolTargetView(source);
  }

  async disableApprovedOverlay(input: {
    readonly actor: IdentitySessionActor;
    readonly schoolId: string;
    readonly overlayRevisionId: string;
    readonly command: DisableSchoolOverlayCommand;
  }): Promise<DisableSchoolOverlayResult> {
    const actorRole = assertReviewer(input.actor);
    if (!UUID.test(input.schoolId) || !UUID.test(input.overlayRevisionId)) {
      throw new SchoolResolutionError("SCHOOL_RESOLUTION_INVALID");
    }
    if (
      !Number.isSafeInteger(input.command.expectedRecordVersion) ||
      input.command.expectedRecordVersion < 1
    ) {
      throw new SchoolResolutionError("SCHOOL_RESOLUTION_INVALID");
    }
    const reason = nonBlank(input.command.reason, 1_024);
    assertRequest(input.command.requestId, input.command.idempotencyKey);

    const rollbackResolvedRevisionId = this.createId();
    const auditId = this.createId();
    const outboxId = this.createId();
    for (const id of [rollbackResolvedRevisionId, auditId, outboxId]) assertUuid(id);
    const disabledAtMs = validNow(this.clock.nowMs());
    const occurredAt = new Date(disabledAtMs).toISOString();
    const eventType = "schools.overlay_revision_disabled";
    const audit = buildAuditEvent({
      id: auditId,
      organizationId: input.actor.organizationId,
      actorUserId: input.actor.userId,
      actorKind: "user",
      eventType,
      eventVersion: 1,
      action: "disable",
      resourceType: "OverlayRevision",
      resourceId: input.overlayRevisionId,
      outcome: "succeeded",
      requestId: input.command.requestId,
      occurredAt,
      metadata: {
        effect_type: "school_overlay_disabled",
        next_version: input.command.expectedRecordVersion + 1,
        status: "disabled",
      },
    });
    const outbox = buildOutboxMessage({
      id: outboxId,
      auditEventId: auditId,
      organizationId: input.actor.organizationId,
      aggregateType: "OverlayRevision",
      aggregateId: input.overlayRevisionId,
      eventType,
      eventVersion: 1,
      idempotencyKey: `school-overlay-disable-${outboxId}`,
      requestId: input.command.requestId,
      payload: {
        aggregate_id: input.overlayRevisionId,
        effect_type: "school_overlay_disabled",
        record_version: input.command.expectedRecordVersion + 1,
        request_id: input.command.requestId,
        status: "disabled",
      },
      availableAt: occurredAt,
      createdAt: occurredAt,
    });

    return this.repository.disableApprovedOverlay({
      organizationId: input.actor.organizationId,
      actorUserId: input.actor.userId,
      actorRole,
      schoolId: input.schoolId,
      overlayRevisionId: input.overlayRevisionId,
      rollbackResolvedRevisionId,
      expectedRecordVersion: input.command.expectedRecordVersion,
      reason,
      requestId: input.command.requestId,
      idempotencyKey: input.command.idempotencyKey,
      requestHash: hashRequestPayload({
        expectedRecordVersion: input.command.expectedRecordVersion,
        overlayRevisionId: input.overlayRevisionId,
        reason,
        schoolId: input.schoolId,
      }),
      disabledAtMs,
      effects: buildAtomicMutationEffects({ audit, outbox }),
    });
  }
}

export function resolveSchoolTargetView(source: SchoolResolutionSource): ResolvedSchoolTargetView {
  let view: ResolvedSchoolView;
  try {
    view = resolveSchoolView(source.base, source.revisions);
  } catch {
    throw new SchoolResolutionError("SCHOOL_RESOLUTION_INVALID");
  }

  if (view.overlayRevisionId !== null) {
    const selected = source.revisions.find(
      (revision) => revision.revisionId === view.overlayRevisionId,
    );
    if (!selected || selected.status !== "approved") {
      throw new SchoolResolutionError("SCHOOL_OVERLAY_NOT_APPROVED");
    }
  }

  const provenance = Object.freeze(
    Object.fromEntries(
      Object.entries(view.provenance).map(([fieldName, fieldProvenance]) => [
        fieldName,
        Object.freeze({ ...fieldProvenance }),
      ]),
    ),
  ) as Readonly<Record<string, SchoolResolutionProvenance>>;
  return Object.freeze({
    view,
    pin: Object.freeze({
      resolvedRevisionId: source.resolvedRevisionId ?? null,
      baseSnapshotId: view.baseSnapshotId,
      overlayRevisionId: view.overlayRevisionId,
      resolutionSha256: view.resolutionSha256,
      provenance,
    }),
  });
}

export function persistResolvedSchoolPin(
  resolved: ResolvedSchoolTargetView,
  resolvedRevisionId: string,
): ResolvedSchoolTargetView {
  assertUuid(resolvedRevisionId);
  return Object.freeze({
    view: resolved.view,
    pin: Object.freeze({ ...resolved.pin, resolvedRevisionId }),
  });
}

function assertReadableActor(actor: IdentitySessionActor): void {
  if (
    !UUID.test(actor.organizationId) ||
    !UUID.test(actor.userId) ||
    !["founder", "advisor", "data_reviewer"].includes(actor.role)
  ) {
    throw new SchoolResolutionError("SCHOOL_RESOLUTION_FORBIDDEN");
  }
}

function assertReviewer(actor: IdentitySessionActor): "founder" | "data_reviewer" {
  if (!UUID.test(actor.organizationId) || !UUID.test(actor.userId)) {
    throw new SchoolResolutionError("SCHOOL_OVERLAY_REVIEWER_REQUIRED");
  }
  if (actor.role === "founder" || actor.role === "data_reviewer") return actor.role;
  throw new SchoolResolutionError("SCHOOL_OVERLAY_REVIEWER_REQUIRED");
}

function assertRequest(requestId: string, idempotencyKey: string): void {
  if (!REQUEST_ID.test(requestId)) throw new SchoolResolutionError("SCHOOL_RESOLUTION_INVALID");
  try {
    validateIdempotencyKey(idempotencyKey);
  } catch {
    throw new SchoolResolutionError("SCHOOL_RESOLUTION_INVALID");
  }
}

function nonBlank(value: unknown, maxLength: number): string {
  if (typeof value !== "string") throw new SchoolResolutionError("SCHOOL_RESOLUTION_INVALID");
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength) {
    throw new SchoolResolutionError("SCHOOL_RESOLUTION_INVALID");
  }
  return normalized;
}

function assertUuid(value: string): void {
  if (!UUID.test(value)) throw new SchoolResolutionError("SCHOOL_RESOLUTION_INVALID");
}

function validNow(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new SchoolResolutionError("SCHOOL_RESOLUTION_INVALID");
  }
  return value;
}
