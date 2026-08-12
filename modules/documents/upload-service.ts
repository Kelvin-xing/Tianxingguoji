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
  assertDocumentVersionIntegrity,
  createOpaqueDocumentObjectKey,
  type DocumentVersionRecord,
} from "./contract.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_REQUEST_ID = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const CONTENT_TYPE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_UPLOAD_INTENT_TTL_MS = 15 * 60 * 1000;
const REQUIRED_UPLOAD_HEADERS = Object.freeze([
  "content-length",
  "content-type",
  "x-amz-checksum-sha256",
] as const);

export interface DocumentUploadClock {
  nowMs(): number;
}

export interface DocumentUploadPolicy {
  readonly maxSizeBytes: number;
  readonly intentTtlMs: number;
}

export interface CreateDocumentUploadIntentCommand {
  readonly documentId: string;
  readonly checksumSha256: string;
  readonly sizeBytes: number;
  readonly contentType: string;
  readonly requestId: string;
  readonly idempotencyKey: string;
}

export interface PrivateDocumentUploadIntent {
  readonly url: string;
  readonly method: "PUT";
  readonly expiresAtMs: number;
  readonly headers: Readonly<Record<string, string>>;
}

export interface DocumentUploadIntentResult {
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly state: "quarantined";
  readonly expiresAtMs: number;
  readonly upload: PrivateDocumentUploadIntent;
}

export interface DocumentUploadRepository {
  /**
   * The production implementation uses one RDS transaction to revalidate the
   * opaque session, lock current case/document authorization, apply scoped
   * idempotency, create one quarantined version, and insert audit plus outbox.
   * It must issue and validate the private PUT capability only after those
   * checks and before the transaction commits. It never stores the signed URL.
   */
  createQuarantinedVersionAndUploadIntent(input: {
    readonly actor: IdentitySessionActor;
    readonly caseId: string;
    readonly version: DocumentVersionRecord;
    readonly expiresAtMs: number;
    readonly requestId: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly createdAtMs: number;
    readonly effects: MutationEffectBundle;
  }): Promise<DocumentUploadIntentResult>;
}

export type DocumentUploadErrorCode =
  | "DOCUMENT_UPLOAD_CASE_FORBIDDEN"
  | "DOCUMENT_UPLOAD_CASE_NOT_FOUND"
  | "DOCUMENT_UPLOAD_DOCUMENT_NOT_FOUND"
  | "DOCUMENT_UPLOAD_DOCUMENT_NOT_ACTIVE"
  | "DOCUMENT_UPLOAD_IDEMPOTENCY_IN_PROGRESS"
  | "DOCUMENT_UPLOAD_IDEMPOTENCY_KEY_REUSED"
  | "DOCUMENT_UPLOAD_INTENT_EXPIRED"
  | "DOCUMENT_UPLOAD_INTENT_MISMATCH"
  | "DOCUMENT_UPLOAD_INVALID"
  | "DOCUMENT_UPLOAD_SESSION_INVALID";

export class DocumentUploadError extends Error {
  readonly code: DocumentUploadErrorCode;

  constructor(code: DocumentUploadErrorCode) {
    super(`Document upload command rejected ${code}.`);
    this.name = "DocumentUploadError";
    this.code = code;
  }
}

export interface DocumentUploadServiceOptions {
  readonly repository: DocumentUploadRepository;
  readonly policy: DocumentUploadPolicy;
  readonly clock?: DocumentUploadClock;
  readonly createId?: () => string;
  readonly bucket: string;
}

/** Documents owns upload-intent construction; the repository owns the write transaction. */
export class DocumentUploadService {
  private readonly repository: DocumentUploadRepository;
  private readonly policy: DocumentUploadPolicy;
  private readonly clock: DocumentUploadClock;
  private readonly createId: () => string;
  private readonly bucket: string;

  constructor(options: DocumentUploadServiceOptions) {
    assertPolicy(options.policy);
    if (typeof options.bucket !== "string" || options.bucket.trim() === "") {
      throw new DocumentUploadError("DOCUMENT_UPLOAD_INVALID");
    }
    this.repository = options.repository;
    this.policy = Object.freeze({ ...options.policy });
    this.clock = options.clock ?? { nowMs: () => Date.now() };
    this.createId = options.createId ?? randomUUID;
    this.bucket = options.bucket;
  }

  async createCaseUploadIntent(input: {
    readonly actor: IdentitySessionActor;
    readonly caseId: string;
    readonly command: CreateDocumentUploadIntentCommand;
  }): Promise<DocumentUploadIntentResult> {
    assertInput(input, this.policy);

    const createdAtMs = this.clock.nowMs();
    if (!Number.isSafeInteger(createdAtMs) || createdAtMs <= 0) {
      throw new DocumentUploadError("DOCUMENT_UPLOAD_INVALID");
    }
    const expiresAtMs = createdAtMs + this.policy.intentTtlMs;
    if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= createdAtMs) {
      throw new DocumentUploadError("DOCUMENT_UPLOAD_INVALID");
    }

    const versionId = this.createId();
    const auditId = this.createId();
    const outboxId = this.createId();
    for (const id of [versionId, auditId, outboxId]) assertUuid(id);

    const version: DocumentVersionRecord = Object.freeze({
      id: versionId,
      organizationId: input.actor.organizationId,
      documentId: input.command.documentId,
      object: Object.freeze({
        region: "ap-east-1",
        bucket: this.bucket,
        key: createOpaqueDocumentObjectKey(input.command.documentId, versionId),
        versionId: null,
      }),
      checksumSha256: input.command.checksumSha256,
      sizeBytes: input.command.sizeBytes,
      detectedContentType: input.command.contentType,
      uploadedBy: input.actor.userId,
      state: "quarantined",
      revokedAt: null,
      recordVersion: 1,
    });
    assertDocumentVersionIntegrity(version);

    const occurredAt = new Date(createdAtMs).toISOString();
    const eventType = "documents.upload_intent_created";
    const audit = buildAuditEvent({
      id: auditId,
      organizationId: input.actor.organizationId,
      actorUserId: input.actor.userId,
      actorKind: "user",
      eventType,
      eventVersion: 1,
      action: "create",
      resourceType: "DocumentVersion",
      resourceId: versionId,
      outcome: "succeeded",
      requestId: input.command.requestId,
      occurredAt,
      afterHashSha256: hashRequestPayload({
        documentId: input.command.documentId,
        state: "quarantined",
        versionId,
      }),
      metadata: {
        effect_type: "document_upload_intent_created",
        record_version: 1,
        status: "quarantined",
      },
    });
    const outbox = buildOutboxMessage({
      id: outboxId,
      auditEventId: auditId,
      organizationId: input.actor.organizationId,
      aggregateType: "DocumentVersion",
      aggregateId: versionId,
      eventType,
      eventVersion: 1,
      idempotencyKey: `document-upload-${outboxId}`,
      requestId: input.command.requestId,
      payload: {
        aggregate_id: versionId,
        effect_type: "document_upload_intent_created",
        request_id: input.command.requestId,
        status: "quarantined",
      },
      availableAt: occurredAt,
      createdAt: occurredAt,
    });

    const result = await this.repository.createQuarantinedVersionAndUploadIntent({
      actor: input.actor,
      caseId: input.caseId,
      version,
      expiresAtMs,
      requestId: input.command.requestId,
      idempotencyKey: input.command.idempotencyKey,
      requestHash: hashRequestPayload({
        caseId: input.caseId,
        checksumSha256: input.command.checksumSha256,
        contentType: input.command.contentType,
        documentId: input.command.documentId,
        sizeBytes: input.command.sizeBytes,
      }),
      createdAtMs,
      effects: buildAtomicMutationEffects({ audit, outbox }),
    });
    assertResult(result, {
      nowMs: createdAtMs,
      documentId: input.command.documentId,
      version,
      latestExpiresAtMs: expiresAtMs,
    });
    return result;
  }
}

function assertInput(
  input: {
    readonly actor: IdentitySessionActor;
    readonly caseId: string;
    readonly command: CreateDocumentUploadIntentCommand;
  },
  policy: DocumentUploadPolicy,
): void {
  const { actor, caseId, command } = input;
  if (
    !UUID.test(actor.organizationId) ||
    !UUID.test(actor.userId) ||
    !UUID.test(actor.sessionId) ||
    !Number.isSafeInteger(actor.capturedSessionVersion) ||
    actor.capturedSessionVersion < 1 ||
    !UUID.test(caseId) ||
    !UUID.test(command.documentId) ||
    !SHA256.test(command.checksumSha256) ||
    !Number.isSafeInteger(command.sizeBytes) ||
    command.sizeBytes < 0 ||
    command.sizeBytes > policy.maxSizeBytes ||
    !CONTENT_TYPE.test(command.contentType) ||
    !SAFE_REQUEST_ID.test(command.requestId)
  ) {
    throw new DocumentUploadError("DOCUMENT_UPLOAD_INVALID");
  }
  try {
    validateIdempotencyKey(command.idempotencyKey);
  } catch {
    throw new DocumentUploadError("DOCUMENT_UPLOAD_INVALID");
  }
}

function assertPolicy(policy: DocumentUploadPolicy): void {
  if (
    !Number.isSafeInteger(policy.maxSizeBytes) ||
    policy.maxSizeBytes < 1 ||
    !Number.isSafeInteger(policy.intentTtlMs) ||
    policy.intentTtlMs < 1 ||
    policy.intentTtlMs > MAX_UPLOAD_INTENT_TTL_MS
  ) {
    throw new DocumentUploadError("DOCUMENT_UPLOAD_INVALID");
  }
}

function assertResult(
  result: DocumentUploadIntentResult,
  expected: {
    readonly nowMs: number;
    readonly documentId: string;
    readonly version: DocumentVersionRecord;
    readonly latestExpiresAtMs: number;
  },
): void {
  if (result.expiresAtMs <= expected.nowMs || result.upload.expiresAtMs <= expected.nowMs) {
    throw new DocumentUploadError("DOCUMENT_UPLOAD_INTENT_EXPIRED");
  }
  if (
    result.documentId !== expected.documentId ||
    !UUID.test(result.documentVersionId) ||
    result.state !== "quarantined" ||
    result.expiresAtMs > expected.latestExpiresAtMs
  ) {
    throw new DocumentUploadError("DOCUMENT_UPLOAD_INTENT_MISMATCH");
  }
  assertPrivateUploadIntent(result.upload, {
    nowMs: expected.nowMs,
    version: expected.version,
    expiresAtMs: result.expiresAtMs,
  });
}

function assertPrivateUploadIntent(
  intent: PrivateDocumentUploadIntent,
  expected: {
    readonly nowMs: number;
    readonly version: DocumentVersionRecord;
    readonly expiresAtMs: number;
  },
): void {
  if (intent.method !== "PUT" || intent.expiresAtMs !== expected.expiresAtMs) {
    throw new DocumentUploadError("DOCUMENT_UPLOAD_INTENT_MISMATCH");
  }
  if (intent.expiresAtMs <= expected.nowMs) {
    throw new DocumentUploadError("DOCUMENT_UPLOAD_INTENT_EXPIRED");
  }
  let url: URL;
  try {
    url = new URL(intent.url);
  } catch {
    throw new DocumentUploadError("DOCUMENT_UPLOAD_INTENT_MISMATCH");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    url.searchParams.get("X-Amz-Algorithm") !== "AWS4-HMAC-SHA256" ||
    !url.searchParams.get("X-Amz-Credential") ||
    !url.searchParams.get("X-Amz-Date") ||
    !url.searchParams.get("X-Amz-Expires") ||
    !url.searchParams.get("X-Amz-SignedHeaders") ||
    !url.searchParams.get("X-Amz-Signature")
  ) {
    throw new DocumentUploadError("DOCUMENT_UPLOAD_INTENT_MISMATCH");
  }

  const headers = normalizeHeaders(intent.headers);
  if (
    headers["content-length"] !== String(expected.version.sizeBytes) ||
    headers["content-type"] !== expected.version.detectedContentType ||
    headers["x-amz-checksum-sha256"] !== expected.version.checksumSha256
  ) {
    throw new DocumentUploadError("DOCUMENT_UPLOAD_INTENT_MISMATCH");
  }
}

function normalizeHeaders(headers: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const normalizedKey = key.toLowerCase();
    if (
      !REQUIRED_UPLOAD_HEADERS.includes(
        normalizedKey as (typeof REQUIRED_UPLOAD_HEADERS)[number],
      ) ||
      Object.hasOwn(normalized, normalizedKey) ||
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > 512
    ) {
      throw new DocumentUploadError("DOCUMENT_UPLOAD_INTENT_MISMATCH");
    }
    normalized[normalizedKey] = value;
  }
  if (Object.keys(normalized).length !== REQUIRED_UPLOAD_HEADERS.length) {
    throw new DocumentUploadError("DOCUMENT_UPLOAD_INTENT_MISMATCH");
  }
  return Object.freeze(normalized);
}

function assertUuid(value: string): void {
  if (!UUID.test(value)) throw new DocumentUploadError("DOCUMENT_UPLOAD_INVALID");
}
