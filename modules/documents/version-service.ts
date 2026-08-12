import { randomUUID } from "node:crypto";

import {
  buildAtomicMutationEffects,
  buildAuditEvent,
  buildOutboxMessage,
  hashRedactedSnapshot,
  type MutationEffectBundle,
} from "../audit/contract.ts";
import type { IdentitySessionActor } from "../identity/session-repository.ts";
import { hashRequestPayload, validateIdempotencyKey } from "../shared/idempotency.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface DocumentVersionClock {
  nowMs(): number;
}

export interface RollbackDocumentVersionCommand {
  readonly targetVersionId: string;
  readonly expectedRecordVersion: number;
  readonly requestId: string;
  readonly idempotencyKey: string;
}

export interface SoftDeleteDocumentCommand {
  readonly expectedRecordVersion: number;
  readonly requestId: string;
  readonly idempotencyKey: string;
}

export interface RestoreDocumentCommand {
  readonly versionId: string;
  readonly expectedRecordVersion: number;
  readonly requestId: string;
  readonly idempotencyKey: string;
}

export interface DocumentVersionMutationResult {
  readonly documentId: string;
  readonly activeVersionId: string | null;
  readonly lifecycleState: "active" | "pending_delete";
  readonly recordVersion: number;
}

interface DocumentVersionRepositoryBaseInput {
  readonly organizationId: string;
  readonly actor: IdentitySessionActor;
  readonly caseId: string;
  readonly documentId: string;
  readonly expectedRecordVersion: number;
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly mutatedAtMs: number;
  readonly effects: MutationEffectBundle;
}

export interface DocumentVersionRepository {
  /**
   * Lock the document, target version, current case authorization, and scoped
   * idempotency record in one RDS transaction. The target must be an available,
   * unrevoked version of this exact document. Persist the pointer revision,
   * idempotency result, audit, and outbox together without rewriting history.
   */
  rollbackToCleanVersion(input: DocumentVersionRepositoryBaseInput & {
    readonly targetVersionId: string;
  }): Promise<DocumentVersionMutationResult>;
  /**
   * Lock current authorization and document state in one transaction. A legal
   * hold blocks even soft deletion; the mutation records pending_delete only.
   */
  softDeleteDocument(input: DocumentVersionRepositoryBaseInput): Promise<DocumentVersionMutationResult>;
  /**
   * Lock the pending-delete document and requested version in one transaction.
   * Recheck the 30-day window and clean/unrevoked version eligibility before
   * restoring the active pointer and atomically writing all effects.
   */
  restoreDocument(input: DocumentVersionRepositoryBaseInput & {
    readonly versionId: string;
  }): Promise<DocumentVersionMutationResult>;
}

export type DocumentVersionErrorCode =
  | "DOCUMENT_VERSION_COMMAND_INVALID"
  | "DOCUMENT_VERSION_CASE_FORBIDDEN"
  | "DOCUMENT_VERSION_NOT_FOUND"
  | "DOCUMENT_VERSION_CLEAN_VERSION_REQUIRED"
  | "DOCUMENT_VERSION_DELETE_LEGAL_HOLD"
  | "DOCUMENT_VERSION_DELETE_NOT_ACTIVE"
  | "DOCUMENT_VERSION_RESTORE_NOT_PENDING_DELETE"
  | "DOCUMENT_VERSION_RESTORE_WINDOW_EXPIRED"
  | "DOCUMENT_VERSION_STALE"
  | "DOCUMENT_VERSION_IDEMPOTENCY_KEY_REUSED"
  | "DOCUMENT_VERSION_IDEMPOTENCY_IN_PROGRESS";

export class DocumentVersionError extends Error {
  readonly code: DocumentVersionErrorCode;

  constructor(code: DocumentVersionErrorCode) {
    super(`Document version command rejected ${code}.`);
    this.name = "DocumentVersionError";
    this.code = code;
  }
}

export interface DocumentVersionServiceOptions {
  readonly repository: DocumentVersionRepository;
  readonly clock?: DocumentVersionClock;
  readonly createId?: () => string;
}

/**
 * Command seam for document pointer revisions and soft-delete recovery. The
 * repository owns authoritative reads plus every durable fact in one RDS
 * transaction; this service constructs only validated, redacted commands.
 */
export class DocumentVersionService {
  private readonly repository: DocumentVersionRepository;
  private readonly clock: DocumentVersionClock;
  private readonly createId: () => string;

  constructor(options: DocumentVersionServiceOptions) {
    this.repository = options.repository;
    this.clock = options.clock ?? { nowMs: () => Date.now() };
    this.createId = options.createId ?? randomUUID;
  }

  async rollbackToCleanVersion(input: {
    readonly actor: IdentitySessionActor;
    readonly caseId: string;
    readonly documentId: string;
    readonly command: RollbackDocumentVersionCommand;
  }): Promise<DocumentVersionMutationResult> {
    assertBaseInput(input);
    if (!UUID.test(input.command.targetVersionId)) {
      throw new DocumentVersionError("DOCUMENT_VERSION_COMMAND_INVALID");
    }
    const mutatedAtMs = this.now();
    const effects = this.effects({
      actor: input.actor,
      documentId: input.documentId,
      requestId: input.command.requestId,
      expectedRecordVersion: input.command.expectedRecordVersion,
      mutatedAtMs,
      eventType: "documents.active_version_rolled_back",
      action: "update",
      status: "active",
      effectType: "document_active_version_rolled_back",
      operation: "documents.version.rollback",
    });
    return this.repository.rollbackToCleanVersion({
      organizationId: input.actor.organizationId,
      actor: input.actor,
      caseId: input.caseId,
      documentId: input.documentId,
      targetVersionId: input.command.targetVersionId,
      expectedRecordVersion: input.command.expectedRecordVersion,
      requestId: input.command.requestId,
      idempotencyKey: input.command.idempotencyKey,
      requestHash: hashRequestPayload({
        case_id: input.caseId,
        document_id: input.documentId,
        expected_record_version: input.command.expectedRecordVersion,
        operation: "rollback",
        target_version_id: input.command.targetVersionId,
      }),
      mutatedAtMs,
      effects,
    });
  }

  async softDeleteDocument(input: {
    readonly actor: IdentitySessionActor;
    readonly caseId: string;
    readonly documentId: string;
    readonly command: SoftDeleteDocumentCommand;
  }): Promise<DocumentVersionMutationResult> {
    assertBaseInput(input);
    const mutatedAtMs = this.now();
    const effects = this.effects({
      actor: input.actor,
      documentId: input.documentId,
      requestId: input.command.requestId,
      expectedRecordVersion: input.command.expectedRecordVersion,
      mutatedAtMs,
      eventType: "documents.delete_requested",
      action: "delete",
      status: "pending_delete",
      effectType: "document_delete_requested",
      operation: "documents.delete",
    });
    return this.repository.softDeleteDocument({
      organizationId: input.actor.organizationId,
      actor: input.actor,
      caseId: input.caseId,
      documentId: input.documentId,
      expectedRecordVersion: input.command.expectedRecordVersion,
      requestId: input.command.requestId,
      idempotencyKey: input.command.idempotencyKey,
      requestHash: hashRequestPayload({
        case_id: input.caseId,
        document_id: input.documentId,
        expected_record_version: input.command.expectedRecordVersion,
        operation: "soft_delete",
      }),
      mutatedAtMs,
      effects,
    });
  }

  async restoreDocument(input: {
    readonly actor: IdentitySessionActor;
    readonly caseId: string;
    readonly documentId: string;
    readonly command: RestoreDocumentCommand;
  }): Promise<DocumentVersionMutationResult> {
    assertBaseInput(input);
    if (!UUID.test(input.command.versionId)) {
      throw new DocumentVersionError("DOCUMENT_VERSION_COMMAND_INVALID");
    }
    const mutatedAtMs = this.now();
    const effects = this.effects({
      actor: input.actor,
      documentId: input.documentId,
      requestId: input.command.requestId,
      expectedRecordVersion: input.command.expectedRecordVersion,
      mutatedAtMs,
      eventType: "documents.restored",
      action: "restore",
      status: "active",
      effectType: "document_restored",
      operation: "documents.restore",
    });
    return this.repository.restoreDocument({
      organizationId: input.actor.organizationId,
      actor: input.actor,
      caseId: input.caseId,
      documentId: input.documentId,
      versionId: input.command.versionId,
      expectedRecordVersion: input.command.expectedRecordVersion,
      requestId: input.command.requestId,
      idempotencyKey: input.command.idempotencyKey,
      requestHash: hashRequestPayload({
        case_id: input.caseId,
        document_id: input.documentId,
        expected_record_version: input.command.expectedRecordVersion,
        operation: "restore",
        version_id: input.command.versionId,
      }),
      mutatedAtMs,
      effects,
    });
  }

  private effects(input: {
    readonly actor: IdentitySessionActor;
    readonly documentId: string;
    readonly requestId: string;
    readonly expectedRecordVersion: number;
    readonly mutatedAtMs: number;
    readonly eventType: string;
    readonly action: "update" | "delete" | "restore";
    readonly status: "active" | "pending_delete";
    readonly effectType: string;
    readonly operation: string;
  }): MutationEffectBundle {
    const auditId = this.id();
    const outboxId = this.id();
    const occurredAt = new Date(input.mutatedAtMs).toISOString();
    const nextRecordVersion = input.expectedRecordVersion + 1;
    const audit = buildAuditEvent({
      id: auditId,
      organizationId: input.actor.organizationId,
      actorUserId: input.actor.userId,
      actorKind: "user",
      eventType: input.eventType,
      eventVersion: 1,
      action: input.action,
      resourceType: "Document",
      resourceId: input.documentId,
      outcome: "succeeded",
      requestId: input.requestId,
      occurredAt,
      beforeHashSha256: hashRedactedSnapshot({
        record_version: input.expectedRecordVersion,
        status: input.action === "restore" ? "pending_delete" : "active",
      }),
      afterHashSha256: hashRedactedSnapshot({
        record_version: nextRecordVersion,
        status: input.status,
      }),
      metadata: {
        previous_version: input.expectedRecordVersion,
        next_version: nextRecordVersion,
        status: input.status,
        effect_type: input.effectType,
      },
    });
    const outbox = buildOutboxMessage({
      id: outboxId,
      auditEventId: auditId,
      organizationId: input.actor.organizationId,
      aggregateType: "Document",
      aggregateId: input.documentId,
      eventType: input.eventType,
      eventVersion: 1,
      idempotencyKey: `document-version-${outboxId}`,
      requestId: input.requestId,
      payload: {
        aggregate_id: input.documentId,
        record_version: nextRecordVersion,
        request_id: input.requestId,
        effect_type: input.effectType,
        operation: input.operation,
        status: input.status,
      },
      availableAt: occurredAt,
      createdAt: occurredAt,
    });
    return buildAtomicMutationEffects({ audit, outbox });
  }

  private now(): number {
    const nowMs = this.clock.nowMs();
    if (!Number.isSafeInteger(nowMs) || nowMs <= 0) {
      throw new DocumentVersionError("DOCUMENT_VERSION_COMMAND_INVALID");
    }
    return nowMs;
  }

  private id(): string {
    const id = this.createId();
    if (!UUID.test(id)) throw new DocumentVersionError("DOCUMENT_VERSION_COMMAND_INVALID");
    return id;
  }
}

function assertBaseInput(input: {
  readonly actor: IdentitySessionActor;
  readonly caseId: string;
  readonly documentId: string;
  readonly command: {
    readonly expectedRecordVersion: number;
    readonly requestId: string;
    readonly idempotencyKey: string;
  };
}): void {
  if (
    !UUID.test(input.actor.organizationId) ||
    !UUID.test(input.actor.userId) ||
    !UUID.test(input.caseId) ||
    !UUID.test(input.documentId) ||
    !Number.isSafeInteger(input.command.expectedRecordVersion) ||
    input.command.expectedRecordVersion < 1 ||
    !REQUEST_ID.test(input.command.requestId)
  ) {
    throw new DocumentVersionError("DOCUMENT_VERSION_COMMAND_INVALID");
  }
  try {
    validateIdempotencyKey(input.command.idempotencyKey);
  } catch {
    throw new DocumentVersionError("DOCUMENT_VERSION_COMMAND_INVALID");
  }
}
