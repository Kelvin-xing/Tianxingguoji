import { randomUUID } from "node:crypto";

import { evaluateBootstrapAuthorization, type OrganizationRole } from "../../access/public.ts";
import {
  buildAtomicMutationEffects,
  buildAuditEvent,
  buildOutboxMessage,
  type MutationEffectBundle,
} from "../../audit/public.ts";
import type { IdentitySessionActor } from "../../identity/public.ts";
import { hashRequestPayload, validateIdempotencyKey } from "../../shared/public.ts";
import {
  DOCUMENT_DOWNLOAD_INTENT_TTL_MS,
  DOCUMENT_UPLOAD_CONTENT_TYPES,
  DOCUMENT_UPLOAD_INTENT_TTL_MS,
  DOCUMENT_UPLOAD_MAX_BYTES,
  createOpaqueDocumentObjectKey,
  type DocumentUploadContentType,
} from "../domain/contract.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const PROVIDER_VERSION = /^\S{1,1024}$/;

export interface DocumentTransferActorContext {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly actorRole: OrganizationRole;
}

export interface DocumentVersionAcknowledgement {
  readonly id: string;
  readonly recordVersion: number;
}

export interface DocumentPendingUploadAuthority {
  readonly id: string;
  readonly documentId: string;
  readonly recordVersion: number;
  readonly contentType: DocumentUploadContentType;
  readonly checksumSha256: string;
  readonly bucket: string;
  readonly key: string;
}

export interface DocumentDownloadAuthority {
  readonly documentId: string;
  readonly documentRecordVersion: number;
  readonly versionId: string;
  readonly versionRecordVersion: number;
  readonly contentType: DocumentUploadContentType;
  readonly bucket: string;
  readonly key: string;
  readonly providerVersionId: string;
}

export interface DocumentUploadIntentResult {
  readonly method: "PUT";
  readonly expiresAtMs: number;
  readonly url: string;
  readonly headers: Readonly<{
    readonly "content-type": DocumentUploadContentType;
    readonly "x-amz-checksum-sha256": string;
  }>;
}

export interface DocumentDownloadIntentResult {
  readonly method: "GET";
  readonly expiresAtMs: number;
  readonly url: string;
  readonly downloadName: "document.pdf" | "document.jpg" | "document.png";
}

export interface DocumentCapabilitySigner {
  issueUploadIntent(input: {
    readonly bucket: string;
    readonly key: string;
    readonly contentType: DocumentUploadContentType;
    readonly checksumSha256Base64: string;
    readonly expiresInSeconds: 600;
  }): Promise<Readonly<{ readonly url: string }>>;
  issueDownloadIntent(input: {
    readonly bucket: string;
    readonly key: string;
    readonly providerVersionId: string;
    readonly expiresInSeconds: 300;
  }): Promise<Readonly<{ readonly url: string }>>;
}

export interface DocumentTransferRepository {
  createVersion(input: DocumentTransferActorContext & {
    readonly caseId: string;
    readonly documentId: string;
    readonly versionId: string;
    readonly bucket: string;
    readonly key: string;
    readonly checksumSha256: string;
    readonly sizeBytes: number;
    readonly contentType: DocumentUploadContentType;
    readonly expectedDocumentRecordVersion: number;
    readonly requestId: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly effects: MutationEffectBundle;
  }): Promise<DocumentVersionAcknowledgement>;
  abandonPendingUpload(input: DocumentTransferActorContext & {
    readonly caseId: string;
    readonly documentId: string;
    readonly versionId: string;
    readonly expectedDocumentRecordVersion: number;
    readonly expectedVersionRecordVersion: number;
    readonly requestId: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly effects: MutationEffectBundle;
  }): Promise<DocumentVersionAcknowledgement>;
  issueUploadIntent(input: DocumentTransferActorContext & {
    readonly caseId: string;
    readonly documentId: string;
    readonly versionId: string;
    readonly expectedRecordVersion: number;
    readonly requestId: string;
    readonly effects: MutationEffectBundle;
    readonly issue: (
      authority: DocumentPendingUploadAuthority,
    ) => Promise<DocumentUploadIntentResult>;
  }): Promise<DocumentUploadIntentResult>;
  issueDownloadIntent(input: DocumentTransferActorContext & {
    readonly caseId: string;
    readonly documentId: string;
    readonly requestId: string;
    readonly effects: MutationEffectBundle;
    readonly issue: (
      authority: DocumentDownloadAuthority,
    ) => Promise<DocumentDownloadIntentResult>;
  }): Promise<DocumentDownloadIntentResult>;
}

export type DocumentTransferErrorCode =
  | "DOCUMENT_TRANSFER_FORBIDDEN"
  | "DOCUMENT_TRANSFER_INVALID"
  | "DOCUMENT_TRANSFER_NOT_FOUND"
  | "DOCUMENT_TRANSFER_STALE_VERSION"
  | "DOCUMENT_TRANSFER_CONFLICT"
  | "DOCUMENT_TRANSFER_INTENT_EXPIRED"
  | "DOCUMENT_TRANSFER_INTENT_MISMATCH"
  | "DOCUMENT_TRANSFER_UNAVAILABLE";

const TRANSFER_ERROR_CODES = new Set<DocumentTransferErrorCode>([
  "DOCUMENT_TRANSFER_FORBIDDEN",
  "DOCUMENT_TRANSFER_INVALID",
  "DOCUMENT_TRANSFER_NOT_FOUND",
  "DOCUMENT_TRANSFER_STALE_VERSION",
  "DOCUMENT_TRANSFER_CONFLICT",
  "DOCUMENT_TRANSFER_INTENT_EXPIRED",
  "DOCUMENT_TRANSFER_INTENT_MISMATCH",
  "DOCUMENT_TRANSFER_UNAVAILABLE",
]);

export class DocumentTransferError extends Error {
  readonly code: DocumentTransferErrorCode;

  constructor(code: DocumentTransferErrorCode) {
    super(`Document transfer rejected ${code}.`);
    this.name = "DocumentTransferError";
    this.code = code;
  }
}

export function isDocumentTransferError(
  value: unknown,
  code?: DocumentTransferErrorCode,
): value is DocumentTransferError {
  if (!(value instanceof Error) || value.name !== "DocumentTransferError") return false;
  const candidate = (value as Error & { code?: unknown }).code;
  return typeof candidate === "string" &&
    TRANSFER_ERROR_CODES.has(candidate as DocumentTransferErrorCode) &&
    (code === undefined || candidate === code);
}

export class DocumentTransferService {
  private readonly repository: DocumentTransferRepository;
  private readonly signer: DocumentCapabilitySigner;
  private readonly bucket: string;
  private readonly allowedHttpOrigin: string | null;
  private readonly createId: () => string;
  private readonly now: () => number;

  constructor(input: {
    readonly repository: DocumentTransferRepository;
    readonly signer: DocumentCapabilitySigner;
    readonly bucket: string;
    readonly allowedHttpOrigin?: string | null;
    readonly createId?: () => string;
    readonly now?: () => number;
  }) {
    if (input.bucket.trim() === "") invalid();
    this.repository = input.repository;
    this.signer = input.signer;
    this.bucket = input.bucket;
    this.allowedHttpOrigin = input.allowedHttpOrigin ?? null;
    this.createId = input.createId ?? randomUUID;
    this.now = input.now ?? Date.now;
  }

  createVersion(input: {
    readonly actor: IdentitySessionActor;
    readonly caseId: string;
    readonly documentId: string;
    readonly command: {
      readonly checksumSha256: string;
      readonly sizeBytes: number;
      readonly contentType: string;
      readonly expectedDocumentRecordVersion: number;
      readonly requestId: string;
      readonly idempotencyKey: string;
    };
  }): Promise<DocumentVersionAcknowledgement> {
    const context = authorize(input.actor, "documents.upload");
    assertCommonIds(input.caseId, input.documentId, input.command.requestId);
    const command = input.command;
    if (!SHA256_HEX.test(command.checksumSha256) ||
        !Number.isSafeInteger(command.sizeBytes) || command.sizeBytes < 1 ||
        command.sizeBytes > DOCUMENT_UPLOAD_MAX_BYTES ||
        !isDocumentUploadContentType(command.contentType) ||
        !isPositiveVersion(command.expectedDocumentRecordVersion)) {
      invalid();
    }
    try {
      validateIdempotencyKey(command.idempotencyKey);
    } catch {
      invalid();
    }

    const versionId = checkedId(this.createId);
    const effects = userEffects({
      actor: input.actor,
      resourceId: versionId,
      requestId: command.requestId,
      occurredAt: checkedNow(this.now),
      eventType: "documents.version_created",
      action: "create",
      resourceType: "DocumentVersion",
      effectType: "documents.version_create",
      status: "pending_upload",
      recordVersion: 1,
      createId: this.createId,
    });
    return this.repository.createVersion({
      ...context,
      caseId: input.caseId,
      documentId: input.documentId,
      versionId,
      bucket: this.bucket,
      key: createOpaqueDocumentObjectKey(input.documentId, versionId),
      checksumSha256: command.checksumSha256,
      sizeBytes: command.sizeBytes,
      contentType: command.contentType,
      expectedDocumentRecordVersion: command.expectedDocumentRecordVersion,
      requestId: command.requestId,
      idempotencyKey: command.idempotencyKey,
      requestHash: hashRequestPayload({
        case_id: input.caseId,
        checksum_sha256: command.checksumSha256,
        content_type: command.contentType,
        document_id: input.documentId,
        expected_document_record_version: command.expectedDocumentRecordVersion,
        size_bytes: command.sizeBytes,
      }),
      effects,
    });
  }

  abandonPendingUpload(input: {
    readonly actor: IdentitySessionActor;
    readonly caseId: string;
    readonly documentId: string;
    readonly versionId: string;
    readonly command: {
      readonly expectedDocumentRecordVersion: number;
      readonly expectedVersionRecordVersion: number;
      readonly requestId: string;
      readonly idempotencyKey: string;
    };
  }): Promise<DocumentVersionAcknowledgement> {
    const context = authorize(input.actor, "documents.upload");
    assertCommonIds(input.caseId, input.documentId, input.command.requestId);
    if (!UUID.test(input.versionId) ||
        !isPositiveVersion(input.command.expectedDocumentRecordVersion) ||
        !isPositiveVersion(input.command.expectedVersionRecordVersion)) {
      invalid();
    }
    try {
      validateIdempotencyKey(input.command.idempotencyKey);
    } catch {
      invalid();
    }

    const nextVersionRecordVersion = input.command.expectedVersionRecordVersion + 1;
    const nextDocumentRecordVersion = input.command.expectedDocumentRecordVersion + 1;
    if (!Number.isSafeInteger(nextVersionRecordVersion) ||
        !Number.isSafeInteger(nextDocumentRecordVersion)) {
      invalid();
    }
    const effects = abandonmentEffects({
      actor: input.actor,
      versionId: input.versionId,
      requestId: input.command.requestId,
      occurredAt: checkedNow(this.now),
      beforeDocumentRecordVersion: input.command.expectedDocumentRecordVersion,
      afterDocumentRecordVersion: nextDocumentRecordVersion,
      beforeVersionRecordVersion: input.command.expectedVersionRecordVersion,
      afterVersionRecordVersion: nextVersionRecordVersion,
      createId: this.createId,
    });
    return this.repository.abandonPendingUpload({
      ...context,
      caseId: input.caseId,
      documentId: input.documentId,
      versionId: input.versionId,
      expectedDocumentRecordVersion: input.command.expectedDocumentRecordVersion,
      expectedVersionRecordVersion: input.command.expectedVersionRecordVersion,
      requestId: input.command.requestId,
      idempotencyKey: input.command.idempotencyKey,
      requestHash: hashRequestPayload({
        case_id: input.caseId,
        document_id: input.documentId,
        expected_document_record_version: input.command.expectedDocumentRecordVersion,
        expected_version_record_version: input.command.expectedVersionRecordVersion,
        version_id: input.versionId,
      }),
      effects,
    });
  }

  issueUploadIntent(input: {
    readonly actor: IdentitySessionActor;
    readonly caseId: string;
    readonly documentId: string;
    readonly versionId: string;
    readonly expectedRecordVersion: number;
    readonly requestId: string;
  }): Promise<DocumentUploadIntentResult> {
    const context = authorize(input.actor, "documents.upload");
    assertCommonIds(input.caseId, input.documentId, input.requestId);
    if (!UUID.test(input.versionId) || !isPositiveVersion(input.expectedRecordVersion)) invalid();
    const issuedAtMs = checkedNowMs(this.now);
    const expiresAtMs = issuedAtMs + DOCUMENT_UPLOAD_INTENT_TTL_MS;
    const effects = userEffects({
      actor: input.actor,
      resourceId: input.versionId,
      requestId: input.requestId,
      occurredAt: new Date(issuedAtMs).toISOString(),
      eventType: "documents.upload_intent_issued",
      action: "update",
      resourceType: "DocumentVersion",
      effectType: "documents.upload_intent",
      status: "pending_upload",
      recordVersion: input.expectedRecordVersion,
      createId: this.createId,
    });
    return this.repository.issueUploadIntent({
      ...context,
      caseId: input.caseId,
      documentId: input.documentId,
      versionId: input.versionId,
      expectedRecordVersion: input.expectedRecordVersion,
      requestId: input.requestId,
      effects,
      issue: async (authority) => {
        if (authority.recordVersion !== input.expectedRecordVersion ||
            authority.id !== input.versionId || authority.documentId !== input.documentId ||
            authority.bucket !== this.bucket ||
            authority.key !== createOpaqueDocumentObjectKey(input.documentId, input.versionId)) {
          mismatch();
        }
        const checksumBase64 = Buffer.from(authority.checksumSha256, "hex").toString("base64");
        const signed = await this.signer.issueUploadIntent({
          bucket: authority.bucket,
          key: authority.key,
          contentType: authority.contentType,
          checksumSha256Base64: checksumBase64,
          expiresInSeconds: 600,
        });
        assertSignedUrl(signed.url, this.allowedHttpOrigin);
        return Object.freeze({
          method: "PUT" as const,
          expiresAtMs,
          url: signed.url,
          headers: Object.freeze({
            "content-type": authority.contentType,
            "x-amz-checksum-sha256": checksumBase64,
          }),
        });
      },
    });
  }

  issueDownloadIntent(input: {
    readonly actor: IdentitySessionActor;
    readonly caseId: string;
    readonly documentId: string;
    readonly requestId: string;
  }): Promise<DocumentDownloadIntentResult> {
    const context = authorize(input.actor, "documents.download");
    assertCommonIds(input.caseId, input.documentId, input.requestId);
    const issuedAtMs = checkedNowMs(this.now);
    const expiresAtMs = issuedAtMs + DOCUMENT_DOWNLOAD_INTENT_TTL_MS;
    const effects = userEffects({
      actor: input.actor,
      resourceId: input.documentId,
      requestId: input.requestId,
      occurredAt: new Date(issuedAtMs).toISOString(),
      eventType: "documents.download_intent_issued",
      action: "read",
      resourceType: "Document",
      effectType: "documents.download_intent",
      status: "available",
      recordVersion: null,
      createId: this.createId,
    });
    return this.repository.issueDownloadIntent({
      ...context,
      caseId: input.caseId,
      documentId: input.documentId,
      requestId: input.requestId,
      effects,
      issue: async (authority) => {
        if (authority.documentId !== input.documentId || authority.bucket !== this.bucket ||
            authority.key !== createOpaqueDocumentObjectKey(input.documentId, authority.versionId) ||
            !PROVIDER_VERSION.test(authority.providerVersionId)) {
          mismatch();
        }
        const signed = await this.signer.issueDownloadIntent({
          bucket: authority.bucket,
          key: authority.key,
          providerVersionId: authority.providerVersionId,
          expiresInSeconds: 300,
        });
        assertSignedUrl(signed.url, this.allowedHttpOrigin);
        return Object.freeze({
          method: "GET" as const,
          expiresAtMs,
          url: signed.url,
          downloadName: downloadName(authority.contentType),
        });
      },
    });
  }
}

export function isDocumentUploadContentType(value: unknown): value is DocumentUploadContentType {
  return typeof value === "string" &&
    (DOCUMENT_UPLOAD_CONTENT_TYPES as readonly string[]).includes(value);
}

function authorize(
  actor: IdentitySessionActor,
  capability: "documents.upload" | "documents.download",
): DocumentTransferActorContext {
  if (!UUID.test(actor.organizationId) || !UUID.test(actor.userId) ||
      !evaluateBootstrapAuthorization(actor.role, { capability }).allowed) {
    forbidden();
  }
  return Object.freeze({
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    actorRole: actor.role,
  });
}

function userEffects(input: {
  readonly actor: IdentitySessionActor;
  readonly resourceId: string;
  readonly requestId: string;
  readonly occurredAt: string;
  readonly eventType: string;
  readonly action: "create" | "read" | "update";
  readonly resourceType: "Document" | "DocumentVersion";
  readonly effectType: string;
  readonly status: string;
  readonly recordVersion: number | null;
  readonly createId: () => string;
}): MutationEffectBundle {
  const auditId = checkedId(input.createId);
  const metadata = input.recordVersion === null
    ? { effect_type: input.effectType, status: input.status }
    : { effect_type: input.effectType, record_version: input.recordVersion, status: input.status };
  const audit = buildAuditEvent({
    id: auditId,
    organizationId: input.actor.organizationId,
    actorUserId: input.actor.userId,
    actorKind: "user",
    eventType: input.eventType,
    eventVersion: 1,
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    outcome: "succeeded",
    requestId: input.requestId,
    occurredAt: input.occurredAt,
    metadata,
  });
  const outbox = buildOutboxMessage({
    id: checkedId(input.createId),
    auditEventId: auditId,
    organizationId: input.actor.organizationId,
    aggregateType: input.resourceType,
    aggregateId: input.resourceId,
    eventType: input.eventType,
    eventVersion: 1,
    idempotencyKey: `document-transfer-${auditId}`,
    requestId: input.requestId,
    payload: {
      aggregate_id: input.resourceId,
      effect_type: input.effectType,
      request_id: input.requestId,
      status: input.status,
    },
    availableAt: input.occurredAt,
    createdAt: input.occurredAt,
  });
  return buildAtomicMutationEffects({ audit, outbox });
}

function abandonmentEffects(input: {
  readonly actor: IdentitySessionActor;
  readonly versionId: string;
  readonly requestId: string;
  readonly occurredAt: string;
  readonly beforeDocumentRecordVersion: number;
  readonly afterDocumentRecordVersion: number;
  readonly beforeVersionRecordVersion: number;
  readonly afterVersionRecordVersion: number;
  readonly createId: () => string;
}): MutationEffectBundle {
  const auditId = checkedId(input.createId);
  const metadata = Object.freeze({
    effect_type: "documents.pending_upload_abandoned",
    status: "abandoned",
    previous_version: input.beforeVersionRecordVersion,
    next_version: input.afterVersionRecordVersion,
  });
  const audit = buildAuditEvent({
    id: auditId,
    organizationId: input.actor.organizationId,
    actorUserId: input.actor.userId,
    actorKind: "user",
    eventType: "documents.pending_upload_abandoned",
    eventVersion: 1,
    action: "update",
    resourceType: "DocumentVersion",
    resourceId: input.versionId,
    outcome: "succeeded",
    requestId: input.requestId,
    occurredAt: input.occurredAt,
    metadata,
  });
  const outbox = buildOutboxMessage({
    id: checkedId(input.createId),
    auditEventId: auditId,
    organizationId: input.actor.organizationId,
    aggregateType: "DocumentVersion",
    aggregateId: input.versionId,
    eventType: "documents.pending_upload_abandoned",
    eventVersion: 1,
    idempotencyKey: `document-transfer-${auditId}`,
    requestId: input.requestId,
    payload: {
      aggregate_id: input.versionId,
      effect_type: "documents.pending_upload_abandoned",
      record_version: input.afterVersionRecordVersion,
      request_id: input.requestId,
      status: "abandoned",
    },
    availableAt: input.occurredAt,
    createdAt: input.occurredAt,
  });
  return buildAtomicMutationEffects({ audit, outbox });
}

function assertCommonIds(caseId: string, documentId: string, requestId: string): void {
  if (!UUID.test(caseId) || !UUID.test(documentId) || !REQUEST_ID.test(requestId)) invalid();
}

function assertSignedUrl(value: string, allowedHttpOrigin: string | null): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    mismatch();
  }
  if (url.username !== "" || url.password !== "" || url.hash !== "") mismatch();
  if (url.protocol === "https:") return;
  if (url.protocol !== "http:" || allowedHttpOrigin === null || url.origin !== allowedHttpOrigin) {
    mismatch();
  }
}

function downloadName(contentType: DocumentUploadContentType): DocumentDownloadIntentResult["downloadName"] {
  if (contentType === "application/pdf") return "document.pdf";
  if (contentType === "image/jpeg") return "document.jpg";
  return "document.png";
}

function checkedId(createId: () => string): string {
  const value = createId();
  if (!UUID.test(value)) invalid();
  return value;
}

function checkedNow(now: () => number): string {
  return new Date(checkedNowMs(now)).toISOString();
}

function checkedNowMs(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value <= 0) invalid();
  return value;
}

function isPositiveVersion(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1;
}

function invalid(): never {
  throw new DocumentTransferError("DOCUMENT_TRANSFER_INVALID");
}

function forbidden(): never {
  throw new DocumentTransferError("DOCUMENT_TRANSFER_FORBIDDEN");
}

function mismatch(): never {
  throw new DocumentTransferError("DOCUMENT_TRANSFER_INTENT_MISMATCH");
}
