import type { MutationEffectBundle } from "../../modules/audit/domain/contract.ts";
import {
  evaluateDocumentRestore,
  evaluateDocumentVersionActivation,
  type DocumentRecord,
  type DocumentVersionRecord,
} from "../../modules/documents/domain/contract.ts";
import {
  DocumentVersionError,
  type DocumentVersionMutationResult,
  type DocumentVersionRepository,
} from "../../modules/documents/application/version-service.ts";

interface StoredDocument {
  readonly caseId: string;
  readonly record: DocumentRecord;
}

interface StoredIdempotencyResult {
  readonly requestHash: string;
  readonly result: DocumentVersionMutationResult;
}

type RollbackInput = Parameters<DocumentVersionRepository["rollbackToCleanVersion"]>[0];
type SoftDeleteInput = Parameters<DocumentVersionRepository["softDeleteDocument"]>[0];
type RestoreInput = Parameters<DocumentVersionRepository["restoreDocument"]>[0];

/**
 * Staged P1-12 transaction adapter. It models authorized case-local document
 * writes without becoming a production persistence fallback.
 */
export class InMemoryDocumentVersionRepository implements DocumentVersionRepository {
  private readonly documents = new Map<string, StoredDocument>();
  private readonly versions = new Map<string, DocumentVersionRecord>();
  private readonly authorizedCaseKeys = new Set<string>();
  private readonly idempotency = new Map<string, StoredIdempotencyResult>();
  private readonly audits = new Map<string, MutationEffectBundle["audit"]>();
  private readonly outbox = new Map<string, MutationEffectBundle["outbox"]>();
  private failNextCommit = false;

  registerDocument(input: {
    readonly caseId: string;
    readonly record: DocumentRecord;
    readonly versions: readonly DocumentVersionRecord[];
  }): void {
    this.documents.set(input.record.id, {
      caseId: input.caseId,
      record: Object.freeze({ ...input.record }),
    });
    for (const version of input.versions) {
      this.versions.set(version.id, Object.freeze({ ...version }));
    }
  }

  authorizeCurrentCase(input: {
    readonly organizationId: string;
    readonly userId: string;
    readonly caseId: string;
  }): void {
    this.authorizedCaseKeys.add(caseAccessKey(input.organizationId, input.userId, input.caseId));
  }

  failOnceBeforeCommit(): void {
    this.failNextCommit = true;
  }

  document(documentId: string): DocumentRecord | undefined {
    return this.documents.get(documentId)?.record;
  }

  version(versionId: string): DocumentVersionRecord | undefined {
    return this.versions.get(versionId);
  }

  snapshot(): Readonly<{
    documents: number;
    versions: number;
    idempotency: number;
    audits: number;
    outbox: number;
  }> {
    return Object.freeze({
      documents: this.documents.size,
      versions: this.versions.size,
      idempotency: this.idempotency.size,
      audits: this.audits.size,
      outbox: this.outbox.size,
    });
  }

  effectPayload(): string {
    return JSON.stringify({ audits: [...this.audits.values()], outbox: [...this.outbox.values()] });
  }

  async rollbackToCleanVersion(input: RollbackInput): Promise<DocumentVersionMutationResult> {
    const stored = this.authorize(input);
    const replay = this.replay(input, "documents.version.rollback");
    if (replay) return replay;
    if (stored.record.recordVersion !== input.expectedRecordVersion) {
      throw new DocumentVersionError("DOCUMENT_VERSION_STALE");
    }

    const target = this.versionForDocument(input.targetVersionId, stored.record);
    const decision = evaluateDocumentVersionActivation({ document: stored.record, version: target });
    if (!decision.allowed) {
      if (decision.code === "DOCUMENT_NOT_ACTIVE") {
        throw new DocumentVersionError("DOCUMENT_VERSION_DELETE_NOT_ACTIVE");
      }
      throw new DocumentVersionError("DOCUMENT_VERSION_CLEAN_VERSION_REQUIRED");
    }

    const result: DocumentVersionMutationResult = Object.freeze({
      documentId: stored.record.id,
      activeVersionId: target.id,
      lifecycleState: "active",
      recordVersion: stored.record.recordVersion + 1,
    });
    const nextRecord: DocumentRecord = Object.freeze({
      ...stored.record,
      activeVersionId: target.id,
      recordVersion: result.recordVersion,
    });
    this.commitMutation({
      input,
      operation: "documents.version.rollback",
      nextRecord,
      result,
    });
    return result;
  }

  async softDeleteDocument(input: SoftDeleteInput): Promise<DocumentVersionMutationResult> {
    const stored = this.authorize(input);
    const replay = this.replay(input, "documents.delete");
    if (replay) return replay;
    if (stored.record.recordVersion !== input.expectedRecordVersion) {
      throw new DocumentVersionError("DOCUMENT_VERSION_STALE");
    }
    if (stored.record.legalHold) {
      throw new DocumentVersionError("DOCUMENT_VERSION_DELETE_LEGAL_HOLD");
    }
    if (stored.record.lifecycleState !== "active") {
      throw new DocumentVersionError("DOCUMENT_VERSION_DELETE_NOT_ACTIVE");
    }

    const result: DocumentVersionMutationResult = Object.freeze({
      documentId: stored.record.id,
      activeVersionId: stored.record.activeVersionId,
      lifecycleState: "pending_delete",
      recordVersion: stored.record.recordVersion + 1,
    });
    const nextRecord: DocumentRecord = Object.freeze({
      ...stored.record,
      lifecycleState: "pending_delete",
      softDeletedAt: new Date(input.mutatedAtMs).toISOString(),
      retentionEndsAt: null,
      recordVersion: result.recordVersion,
    });
    this.commitMutation({
      input,
      operation: "documents.delete",
      nextRecord,
      result,
    });
    return result;
  }

  async restoreDocument(input: RestoreInput): Promise<DocumentVersionMutationResult> {
    const stored = this.authorize(input);
    const replay = this.replay(input, "documents.restore");
    if (replay) return replay;
    if (stored.record.recordVersion !== input.expectedRecordVersion) {
      throw new DocumentVersionError("DOCUMENT_VERSION_STALE");
    }

    const target = this.versionForDocument(input.versionId, stored.record);
    const decision = evaluateDocumentRestore({
      document: stored.record,
      version: target,
      now: new Date(input.mutatedAtMs).toISOString(),
      expectedRecordVersion: input.expectedRecordVersion,
    });
    if (!decision.allowed) {
      throw restoreError(decision.code);
    }

    const result: DocumentVersionMutationResult = Object.freeze({
      documentId: stored.record.id,
      activeVersionId: target.id,
      lifecycleState: "active",
      recordVersion: stored.record.recordVersion + 1,
    });
    const nextRecord: DocumentRecord = Object.freeze({
      ...stored.record,
      lifecycleState: "active",
      activeVersionId: target.id,
      softDeletedAt: null,
      retentionEndsAt: null,
      recordVersion: result.recordVersion,
    });
    this.commitMutation({
      input,
      operation: "documents.restore",
      nextRecord,
      result,
    });
    return result;
  }

  private authorize(input: {
    readonly organizationId: string;
    readonly actor: { readonly organizationId: string; readonly userId: string };
    readonly caseId: string;
    readonly documentId: string;
  }): StoredDocument {
    const stored = this.documents.get(input.documentId);
    if (
      !stored ||
      input.organizationId !== input.actor.organizationId ||
      stored.record.organizationId !== input.organizationId ||
      stored.caseId !== input.caseId ||
      !this.authorizedCaseKeys.has(caseAccessKey(input.organizationId, input.actor.userId, input.caseId))
    ) {
      throw new DocumentVersionError("DOCUMENT_VERSION_CASE_FORBIDDEN");
    }
    return stored;
  }

  private versionForDocument(versionId: string, document: DocumentRecord): DocumentVersionRecord {
    const version = this.versions.get(versionId);
    if (
      !version ||
      version.organizationId !== document.organizationId ||
      version.documentId !== document.id
    ) {
      throw new DocumentVersionError("DOCUMENT_VERSION_NOT_FOUND");
    }
    return version;
  }

  private replay(input: {
    readonly actor: { readonly organizationId: string; readonly userId: string };
    readonly idempotencyKey: string;
    readonly requestHash: string;
  }, operation: string): DocumentVersionMutationResult | null {
    const scope = idempotencyScope(input.actor.organizationId, input.actor.userId, operation, input.idempotencyKey);
    const existing = this.idempotency.get(scope);
    if (!existing) return null;
    if (existing.requestHash !== input.requestHash) {
      throw new DocumentVersionError("DOCUMENT_VERSION_IDEMPOTENCY_KEY_REUSED");
    }
    return existing.result;
  }

  private commitMutation(input: {
    readonly input: {
      readonly actor: { readonly organizationId: string; readonly userId: string };
      readonly documentId: string;
      readonly idempotencyKey: string;
      readonly requestHash: string;
      readonly effects: MutationEffectBundle;
    };
    readonly operation: string;
    readonly nextRecord: DocumentRecord;
    readonly result: DocumentVersionMutationResult;
  }): void {
    assertEffects(input.input.effects, input.nextRecord);
    const nextDocuments = new Map(this.documents);
    const stored = nextDocuments.get(input.input.documentId);
    if (!stored) throw new DocumentVersionError("DOCUMENT_VERSION_NOT_FOUND");
    nextDocuments.set(input.input.documentId, { ...stored, record: input.nextRecord });
    const nextIdempotency = new Map(this.idempotency);
    const scope = idempotencyScope(
      input.input.actor.organizationId,
      input.input.actor.userId,
      input.operation,
      input.input.idempotencyKey,
    );
    nextIdempotency.set(scope, { requestHash: input.input.requestHash, result: input.result });
    const nextAudits = new Map(this.audits);
    const nextOutbox = new Map(this.outbox);
    nextAudits.set(input.input.effects.audit.id, input.input.effects.audit);
    nextOutbox.set(input.input.effects.outbox.id, input.input.effects.outbox);

    if (this.failNextCommit) {
      this.failNextCommit = false;
      throw new Error("synthetic document version transaction failure");
    }
    replaceMap(this.documents, nextDocuments);
    replaceMap(this.idempotency, nextIdempotency);
    replaceMap(this.audits, nextAudits);
    replaceMap(this.outbox, nextOutbox);
  }
}

function restoreError(code: string): DocumentVersionError {
  switch (code) {
    case "DOCUMENT_STALE_VERSION":
      return new DocumentVersionError("DOCUMENT_VERSION_STALE");
    case "DOCUMENT_RESTORE_REQUIRES_PENDING_DELETE":
    case "DOCUMENT_SOFT_DELETE_REQUIRED":
      return new DocumentVersionError("DOCUMENT_VERSION_RESTORE_NOT_PENDING_DELETE");
    case "DOCUMENT_SOFT_DELETE_WINDOW_EXPIRED":
      return new DocumentVersionError("DOCUMENT_VERSION_RESTORE_WINDOW_EXPIRED");
    case "DOCUMENT_CONTEXT_MISMATCH":
      return new DocumentVersionError("DOCUMENT_VERSION_NOT_FOUND");
    default:
      return new DocumentVersionError("DOCUMENT_VERSION_CLEAN_VERSION_REQUIRED");
  }
}

function assertEffects(effects: MutationEffectBundle, document: DocumentRecord): void {
  if (
    effects.audit.organizationId !== document.organizationId ||
    effects.audit.resourceId !== document.id ||
    effects.outbox.organizationId !== document.organizationId ||
    effects.outbox.aggregateId !== document.id ||
    effects.audit.eventType !== effects.outbox.eventType ||
    effects.audit.requestId !== effects.outbox.requestId
  ) {
    throw new DocumentVersionError("DOCUMENT_VERSION_COMMAND_INVALID");
  }
}

function caseAccessKey(organizationId: string, userId: string, caseId: string): string {
  return `${organizationId}:${userId}:${caseId}`;
}

function idempotencyScope(
  organizationId: string,
  userId: string,
  operation: string,
  idempotencyKey: string,
): string {
  return `${organizationId}:${userId}:${operation}:${idempotencyKey}`;
}

function replaceMap<Key, Value>(target: Map<Key, Value>, source: Map<Key, Value>): void {
  target.clear();
  for (const [key, value] of source) target.set(key, value);
}
