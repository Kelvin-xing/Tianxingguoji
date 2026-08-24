import { createHash, randomUUID } from "node:crypto";

import {
  buildAtomicMutationEffects,
  buildAuditEvent,
  buildOutboxMessage,
  type MutationEffectBundle,
} from "../../audit/public.ts";
import {
  DOCUMENT_SCAN_POLICY_VERSION,
  isOpaqueDocumentObjectKey,
} from "../domain/contract.ts";
import type { DocumentScanEvent } from "./scan-service.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROVIDER_VERSION = /^\S{1,1024}$/;

export type DocumentObjectReceiptResult =
  | { readonly status: "ready" }
  | { readonly status: "rejected" }
  | { readonly status: "in_progress" }
  | { readonly status: "duplicate" }
  | { readonly status: "abandoned_cleanup"; readonly documentVersionId: string }
  | {
      readonly status: "unbound_provider_version_cleanup";
      readonly documentVersionId: string;
    };

export type DocumentObjectCleanupResult =
  | { readonly status: "recorded" }
  | { readonly status: "duplicate" };

export interface DocumentObjectHead {
  readonly sizeBytes: number;
  readonly contentType: string;
  readonly checksumSha256Base64: string;
}

export interface DocumentObjectReceiptRepository {
  receive(input: {
    readonly organizationId: string;
    readonly event: DocumentScanEvent;
    readonly loadHead: () => Promise<DocumentObjectHead>;
    readonly scanResultId: string;
    readonly createEffects: (input: {
      readonly documentVersionId: string;
      readonly status: "quarantined" | "rejected";
    }) => MutationEffectBundle;
  }): Promise<DocumentObjectReceiptResult>;
  recordAbandonedObjectRemoval(input: {
    readonly organizationId: string;
    readonly event: DocumentScanEvent;
    readonly documentVersionId: string;
    readonly effectIdempotencyKey: string;
    readonly createEffects: () => MutationEffectBundle;
  }): Promise<DocumentObjectCleanupResult>;
  recordUnboundProviderVersionRemoval(input: {
    readonly organizationId: string;
    readonly event: DocumentScanEvent;
    readonly documentVersionId: string;
    readonly effectIdempotencyKey: string;
    readonly createEffects: () => MutationEffectBundle;
  }): Promise<DocumentObjectCleanupResult>;
}

export type DocumentObjectReceiptErrorCode =
  | "DOCUMENT_OBJECT_RECEIPT_INVALID"
  | "DOCUMENT_OBJECT_RECEIPT_UNAVAILABLE";

export class DocumentObjectReceiptError extends Error {
  readonly code: DocumentObjectReceiptErrorCode;

  constructor(code: DocumentObjectReceiptErrorCode) {
    super(`Document object receipt rejected ${code}.`);
    this.name = "DocumentObjectReceiptError";
    this.code = code;
  }
}

export function isDocumentObjectReceiptError(value: unknown): value is DocumentObjectReceiptError {
  if (!(value instanceof Error) || value.name !== "DocumentObjectReceiptError") return false;
  const code = (value as Error & { code?: unknown }).code;
  return code === "DOCUMENT_OBJECT_RECEIPT_INVALID" ||
    code === "DOCUMENT_OBJECT_RECEIPT_UNAVAILABLE";
}

export class DocumentObjectReceiptService {
  private readonly repository: DocumentObjectReceiptRepository;
  private readonly organizationId: string;
  private readonly createId: () => string;
  private readonly now: () => number;
  private readonly headTimeoutMs: number;

  constructor(input: {
    readonly repository: DocumentObjectReceiptRepository;
    readonly organizationId: string;
    readonly createId?: () => string;
    readonly now?: () => number;
    readonly headTimeoutMs?: number;
  }) {
    if (!UUID.test(input.organizationId) ||
        (input.headTimeoutMs !== undefined &&
          (!Number.isSafeInteger(input.headTimeoutMs) ||
            input.headTimeoutMs < 250 || input.headTimeoutMs > 10_000))) {
      invalid();
    }
    this.repository = input.repository;
    this.organizationId = input.organizationId;
    this.createId = input.createId ?? randomUUID;
    this.now = input.now ?? Date.now;
    this.headTimeoutMs = input.headTimeoutMs ?? 2_000;
  }

  async receive(
    event: DocumentScanEvent,
    loadHead: (signal: AbortSignal) => Promise<DocumentObjectHead>,
  ): Promise<DocumentObjectReceiptResult> {
    const documentVersionId = versionIdFromKey(event.key);
    validateEvent(event);
    if (typeof loadHead !== "function") invalid();
    const scanResultId = checkedId(this.createId);
    const occurredAtMs = this.now();
    if (!Number.isSafeInteger(occurredAtMs) || occurredAtMs <= 0) invalid();
    const result = await this.repository.receive({
      organizationId: this.organizationId,
      event: Object.freeze({ ...event, scanPolicyVersion: DOCUMENT_SCAN_POLICY_VERSION }),
      loadHead: () => loadBoundedHead(loadHead, this.headTimeoutMs),
      scanResultId,
      createEffects: ({ documentVersionId: authoritativeVersionId, status }) => {
        if (authoritativeVersionId !== documentVersionId) invalid();
        const occurredAt = new Date(occurredAtMs).toISOString();
        const auditId = checkedId(this.createId);
        const eventType = status === "quarantined"
          ? "documents.object_received"
          : "documents.object_rejected";
        const effectType = status === "quarantined"
          ? "documents.object_received"
          : "documents.object_rejected";
        const audit = buildAuditEvent({
          id: auditId,
          organizationId: this.organizationId,
          actorUserId: null,
          actorKind: "worker",
          eventType,
          eventVersion: 1,
          action: "update",
          resourceType: "DocumentVersion",
          resourceId: documentVersionId,
          outcome: "succeeded",
          requestId: event.requestId,
          occurredAt,
          metadata: { effect_type: effectType, status },
        });
        const outbox = buildOutboxMessage({
          id: checkedId(this.createId),
          auditEventId: auditId,
          organizationId: this.organizationId,
          aggregateType: "DocumentVersion",
          aggregateId: documentVersionId,
          eventType,
          eventVersion: 1,
          idempotencyKey: `document-receipt-${auditId}`,
          requestId: event.requestId,
          payload: {
            aggregate_id: documentVersionId,
            effect_type: effectType,
            request_id: event.requestId,
            status,
          },
          availableAt: occurredAt,
          createdAt: occurredAt,
        });
        return buildAtomicMutationEffects({ audit, outbox });
      },
    });
    return checkedReceiptResult(result, documentVersionId);
  }

  async recordAbandonedObjectRemoval(
    event: DocumentScanEvent,
    documentVersionId: string,
  ): Promise<DocumentObjectCleanupResult> {
    const authoritativeVersionId = versionIdFromKey(event.key);
    validateEvent(event);
    if (!UUID.test(documentVersionId) || documentVersionId !== authoritativeVersionId) invalid();
    const occurredAtMs = this.now();
    if (!Number.isSafeInteger(occurredAtMs) || occurredAtMs <= 0) invalid();
    const effectIdempotencyKey = abandonedCleanupIdempotencyKey(this.organizationId, event);
    const result = await this.repository.recordAbandonedObjectRemoval({
      organizationId: this.organizationId,
      event: Object.freeze({ ...event, scanPolicyVersion: DOCUMENT_SCAN_POLICY_VERSION }),
      documentVersionId,
      effectIdempotencyKey,
      createEffects: () => {
        const occurredAt = new Date(occurredAtMs).toISOString();
        const auditId = checkedId(this.createId);
        const eventType = "documents.abandoned_object_removed";
        const effectType = "documents.abandoned_object_removed";
        const audit = buildAuditEvent({
          id: auditId,
          organizationId: this.organizationId,
          actorUserId: null,
          actorKind: "worker",
          eventType,
          eventVersion: 1,
          action: "delete",
          resourceType: "DocumentVersion",
          resourceId: documentVersionId,
          outcome: "succeeded",
          requestId: event.requestId,
          occurredAt,
          metadata: { effect_type: effectType, status: "removed" },
        });
        const outbox = buildOutboxMessage({
          id: checkedId(this.createId),
          auditEventId: auditId,
          organizationId: this.organizationId,
          aggregateType: "DocumentVersion",
          aggregateId: documentVersionId,
          eventType,
          eventVersion: 1,
          idempotencyKey: effectIdempotencyKey,
          requestId: event.requestId,
          payload: {
            aggregate_id: documentVersionId,
            effect_type: effectType,
            request_id: event.requestId,
            status: "removed",
          },
          availableAt: occurredAt,
          createdAt: occurredAt,
        });
        return buildAtomicMutationEffects({ audit, outbox });
      },
    });
    return checkedCleanupResult(result);
  }

  async recordUnboundProviderVersionRemoval(
    event: DocumentScanEvent,
    documentVersionId: string,
  ): Promise<DocumentObjectCleanupResult> {
    const authoritativeDocumentId = documentIdFromKey(event.key);
    const authoritativeVersionId = versionIdFromKey(event.key);
    validateEvent(event);
    if (!UUID.test(documentVersionId) || documentVersionId !== authoritativeVersionId) invalid();
    const occurredAtMs = this.now();
    if (!Number.isSafeInteger(occurredAtMs) || occurredAtMs <= 0) invalid();
    const effectIdempotencyKey = unboundProviderCleanupIdempotencyKey(
      this.organizationId,
      authoritativeDocumentId,
      documentVersionId,
      event,
    );
    const result = await this.repository.recordUnboundProviderVersionRemoval({
      organizationId: this.organizationId,
      event: Object.freeze({ ...event, scanPolicyVersion: DOCUMENT_SCAN_POLICY_VERSION }),
      documentVersionId,
      effectIdempotencyKey,
      createEffects: () => {
        const occurredAt = new Date(occurredAtMs).toISOString();
        const auditId = checkedId(this.createId);
        const eventType = "documents.unbound_provider_version_removed";
        const audit = buildAuditEvent({
          id: auditId,
          organizationId: this.organizationId,
          actorUserId: null,
          actorKind: "worker",
          eventType,
          eventVersion: 1,
          action: "delete",
          resourceType: "DocumentVersion",
          resourceId: documentVersionId,
          outcome: "succeeded",
          requestId: event.requestId,
          occurredAt,
          metadata: { effect_type: eventType, status: "removed" },
        });
        const outbox = buildOutboxMessage({
          id: checkedId(this.createId),
          auditEventId: auditId,
          organizationId: this.organizationId,
          aggregateType: "DocumentVersion",
          aggregateId: documentVersionId,
          eventType,
          eventVersion: 1,
          idempotencyKey: effectIdempotencyKey,
          requestId: event.requestId,
          payload: {
            aggregate_id: documentVersionId,
            effect_type: eventType,
            request_id: event.requestId,
            status: "removed",
          },
          availableAt: occurredAt,
          createdAt: occurredAt,
        });
        return buildAtomicMutationEffects({ audit, outbox });
      },
    });
    return checkedCleanupResult(result);
  }
}

async function loadBoundedHead(
  loadHead: (signal: AbortSignal) => Promise<DocumentObjectHead>,
  timeoutMs: number,
): Promise<DocumentObjectHead> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const head = await Promise.race([
      loadHead(controller.signal),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new DocumentObjectReceiptError("DOCUMENT_OBJECT_RECEIPT_UNAVAILABLE"));
        }, timeoutMs);
      }),
    ]);
    if (!Number.isSafeInteger(head.sizeBytes) || head.sizeBytes < 0 ||
        typeof head.contentType !== "string" || typeof head.checksumSha256Base64 !== "string") {
      invalid();
    }
    return Object.freeze({ ...head });
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function checkedReceiptResult(
  result: DocumentObjectReceiptResult,
  documentVersionId: string,
): DocumentObjectReceiptResult {
  if (result.status === "abandoned_cleanup" ||
      result.status === "unbound_provider_version_cleanup") {
    if (!isExactObject(result, ["status", "documentVersionId"]) ||
        result.documentVersionId !== documentVersionId) {
      unavailable();
    }
    return Object.freeze({ status: result.status, documentVersionId });
  }
  if (!isExactObject(result, ["status"]) ||
      !["ready", "rejected", "in_progress", "duplicate"].includes(result.status)) {
    unavailable();
  }
  return Object.freeze({ status: result.status });
}

function checkedCleanupResult(result: DocumentObjectCleanupResult): DocumentObjectCleanupResult {
  if (!isExactObject(result, ["status"]) ||
      (result.status !== "recorded" && result.status !== "duplicate")) {
    unavailable();
  }
  return Object.freeze({ status: result.status });
}

function isExactObject(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function abandonedCleanupIdempotencyKey(
  organizationId: string,
  event: DocumentScanEvent,
): string {
  const digest = createHash("sha256")
    .update(organizationId)
    .update("\0")
    .update(event.bucket)
    .update("\0")
    .update(event.key)
    .update("\0")
    .update(event.versionId)
    .digest("hex");
  return `document-abandoned-object-removed-${digest}`;
}

function unboundProviderCleanupIdempotencyKey(
  organizationId: string,
  documentId: string,
  documentVersionId: string,
  event: DocumentScanEvent,
): string {
  const digest = createHash("sha256")
    .update(organizationId)
    .update("\0")
    .update(documentId)
    .update("\0")
    .update(documentVersionId)
    .update("\0")
    .update(event.bucket)
    .update("\0")
    .update(event.key)
    .update("\0")
    .update(event.versionId)
    .digest("hex");
  return `document-unbound-provider-version-removed-${digest}`;
}

function validateEvent(event: DocumentScanEvent): void {
  if (!PROVIDER_VERSION.test(event.versionId) ||
      event.scanPolicyVersion !== DOCUMENT_SCAN_POLICY_VERSION) {
    invalid();
  }
}

function versionIdFromKey(key: string): string {
  if (!isOpaqueDocumentObjectKey(key)) invalid();
  const value = key.split("/").at(-1);
  if (!value || !UUID.test(value)) invalid();
  return value;
}

function documentIdFromKey(key: string): string {
  if (!isOpaqueDocumentObjectKey(key)) invalid();
  const value = key.split("/")[1];
  if (!value || !UUID.test(value)) invalid();
  return value;
}

function checkedId(createId: () => string): string {
  const value = createId();
  if (!UUID.test(value)) invalid();
  return value;
}

function invalid(): never {
  throw new DocumentObjectReceiptError("DOCUMENT_OBJECT_RECEIPT_INVALID");
}

function unavailable(): never {
  throw new DocumentObjectReceiptError("DOCUMENT_OBJECT_RECEIPT_UNAVAILABLE");
}
