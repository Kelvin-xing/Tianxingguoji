import type { MutationEffectBundle } from "../../modules/audit/contract.ts";
import type { IdentitySessionActor } from "../../modules/identity/session-repository.ts";
import {
  DocumentUploadError,
  type DocumentUploadIntentResult,
  type DocumentUploadRepository,
} from "../../modules/documents/upload-service.ts";
import type { DocumentVersionRecord } from "../../modules/documents/contract.ts";

interface StoredDocument {
  readonly organizationId: string;
  readonly caseId: string;
  readonly active: boolean;
}

interface StoredResult {
  readonly requestHash: string;
  readonly result: DocumentUploadIntentResult;
}

/** A staged in-memory transaction model for the P1-10 document upload port. */
export class InMemoryDocumentUploadRepository implements DocumentUploadRepository {
  private readonly documents = new Map<string, StoredDocument>();
  private readonly authorizedCaseKeys = new Set<string>();
  private readonly resultsByIdempotency = new Map<string, StoredResult>();
  private readonly versions = new Map<string, DocumentVersionRecord>();
  private readonly audits = new Map<string, MutationEffectBundle["audit"]>();
  private readonly outbox = new Map<string, MutationEffectBundle["outbox"]>();
  private failNextCommit = false;

  registerDocument(input: {
    readonly documentId: string;
    readonly organizationId: string;
    readonly caseId: string;
    readonly active?: boolean;
  }): void {
    this.documents.set(input.documentId, {
      organizationId: input.organizationId,
      caseId: input.caseId,
      active: input.active ?? true,
    });
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

  snapshot(): Readonly<{
    idempotency: number;
    versions: number;
    audits: number;
    outbox: number;
  }> {
    return Object.freeze({
      idempotency: this.resultsByIdempotency.size,
      versions: this.versions.size,
      audits: this.audits.size,
      outbox: this.outbox.size,
    });
  }

  version(documentVersionId: string): DocumentVersionRecord | undefined {
    return this.versions.get(documentVersionId);
  }

  auditPayload(): string {
    return JSON.stringify([...this.audits.values()]);
  }

  outboxPayload(): string {
    return JSON.stringify([...this.outbox.values()]);
  }

  async createQuarantinedVersionAndUploadIntent(input: {
    readonly actor: IdentitySessionActor;
    readonly caseId: string;
    readonly version: DocumentVersionRecord;
    readonly expiresAtMs: number;
    readonly requestId: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly createdAtMs: number;
    readonly effects: MutationEffectBundle;
  }): Promise<DocumentUploadIntentResult> {
    const document = this.documents.get(input.version.documentId);
    if (
      !document ||
      document.organizationId !== input.actor.organizationId ||
      document.caseId !== input.caseId
    ) {
      throw new DocumentUploadError("DOCUMENT_UPLOAD_CASE_FORBIDDEN");
    }
    if (!document.active) throw new DocumentUploadError("DOCUMENT_UPLOAD_DOCUMENT_NOT_ACTIVE");
    if (!this.authorizedCaseKeys.has(caseAccessKey(input.actor.organizationId, input.actor.userId, input.caseId))) {
      throw new DocumentUploadError("DOCUMENT_UPLOAD_CASE_FORBIDDEN");
    }

    const idempotencyScope = [
      input.actor.organizationId,
      input.actor.userId,
      "documents.upload_intent.create",
      input.idempotencyKey,
    ].join(":");
    const existing = this.resultsByIdempotency.get(idempotencyScope);
    if (existing) {
      if (existing.requestHash !== input.requestHash) {
        throw new DocumentUploadError("DOCUMENT_UPLOAD_IDEMPOTENCY_KEY_REUSED");
      }
      return existing.result;
    }

    if (input.version.state !== "quarantined" || input.version.object.versionId !== null) {
      throw new DocumentUploadError("DOCUMENT_UPLOAD_INTENT_MISMATCH");
    }
    const result: DocumentUploadIntentResult = Object.freeze({
      documentId: input.version.documentId,
      documentVersionId: input.version.id,
      state: "quarantined",
      expiresAtMs: input.expiresAtMs,
      upload: Object.freeze({
        url: `https://private-upload.example.test/put?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=synthetic&X-Amz-Date=20260807T000000Z&X-Amz-Expires=600&X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bx-amz-checksum-sha256&X-Amz-Signature=synthetic`,
        method: "PUT",
        expiresAtMs: input.expiresAtMs,
        headers: Object.freeze({
          "content-length": String(input.version.sizeBytes),
          "content-type": input.version.detectedContentType,
          "x-amz-checksum-sha256": input.version.checksumSha256,
        }),
      }),
    });

    const nextResults = new Map(this.resultsByIdempotency);
    const nextVersions = new Map(this.versions);
    const nextAudits = new Map(this.audits);
    const nextOutbox = new Map(this.outbox);
    nextResults.set(idempotencyScope, { requestHash: input.requestHash, result });
    nextVersions.set(input.version.id, input.version);
    nextAudits.set(input.effects.audit.id, input.effects.audit);
    nextOutbox.set(input.effects.outbox.id, input.effects.outbox);

    if (this.failNextCommit) {
      this.failNextCommit = false;
      throw new Error("synthetic transaction failure");
    }

    replaceMap(this.resultsByIdempotency, nextResults);
    replaceMap(this.versions, nextVersions);
    replaceMap(this.audits, nextAudits);
    replaceMap(this.outbox, nextOutbox);
    return result;
  }
}

function caseAccessKey(organizationId: string, userId: string, caseId: string): string {
  return `${organizationId}:${userId}:${caseId}`;
}

function replaceMap<Key, Value>(target: Map<Key, Value>, source: Map<Key, Value>): void {
  target.clear();
  for (const [key, value] of source) target.set(key, value);
}
