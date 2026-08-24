import {
  DocumentTransferError,
  DocumentWorkspaceError,
  isDocumentTransferError,
  isDocumentTransferRuntimeUnavailable,
  isDocumentWorkspaceError,
  isDocumentWorkspaceRuntimeUnavailable,
  type CaseDocumentView,
  type DocumentAcknowledgement,
  type DocumentCollectionView,
  type DocumentDownloadIntentResult,
  type DocumentUploadIntentResult,
  type DocumentVersionAcknowledgement,
} from "../../../../modules/documents/server.ts";
import { createApiError, type JsonValue } from "../../../../modules/shared/public.ts";

const REGISTRATION_KEYS = ["classification", "display_name"] as const;
const VERSION_CREATE_KEYS = [
  "checksum_sha256",
  "content_type",
  "expected_document_record_version",
  "size_bytes",
] as const;
const UPLOAD_INTENT_KEYS = ["expected_record_version"] as const;
const ABANDONMENT_KEYS = [
  "expected_document_record_version",
  "expected_version_record_version",
] as const;

export function assertNoDocumentQuery(request: Request): void {
  if ([...new URL(request.url).searchParams.keys()].length !== 0) invalid();
}

export async function parseDocumentRegistration(request: Request, requestId: string) {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") {
    invalid();
  }
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    invalid();
  }
  if (!isRecord(value) || !hasExactKeys(value, REGISTRATION_KEYS) ||
      typeof value.display_name !== "string" || typeof value.classification !== "string") {
    invalid();
  }
  const idempotencyKey = request.headers.get("idempotency-key");
  if (!idempotencyKey) invalid();
  return Object.freeze({
    displayName: value.display_name,
    classification: value.classification,
    requestId,
    idempotencyKey,
  });
}

export async function parseDocumentVersionCreate(request: Request, requestId: string) {
  const value = await exactJson(request);
  if (!hasExactKeys(value, VERSION_CREATE_KEYS) ||
      typeof value.checksum_sha256 !== "string" ||
      typeof value.content_type !== "string" ||
      typeof value.expected_document_record_version !== "number" ||
      typeof value.size_bytes !== "number") {
    invalidTransfer();
  }
  const idempotencyKey = request.headers.get("idempotency-key");
  if (!idempotencyKey) invalidTransfer();
  return Object.freeze({
    checksumSha256: value.checksum_sha256,
    contentType: value.content_type,
    expectedDocumentRecordVersion: value.expected_document_record_version,
    sizeBytes: value.size_bytes,
    requestId,
    idempotencyKey,
  });
}

export async function parseDocumentUploadIntent(request: Request) {
  const value = await exactJson(request);
  if (!hasExactKeys(value, UPLOAD_INTENT_KEYS) ||
      typeof value.expected_record_version !== "number") {
    invalidTransfer();
  }
  if (request.headers.has("idempotency-key")) invalidTransfer();
  return Object.freeze({ expectedRecordVersion: value.expected_record_version });
}

export async function parseDocumentVersionAbandonment(request: Request, requestId: string) {
  const value = await exactJson(request);
  if (!hasExactKeys(value, ABANDONMENT_KEYS) ||
      typeof value.expected_document_record_version !== "number" ||
      typeof value.expected_version_record_version !== "number") {
    invalidTransfer();
  }
  const idempotencyKey = request.headers.get("idempotency-key");
  if (!idempotencyKey) invalidTransfer();
  return Object.freeze({
    expectedDocumentRecordVersion: value.expected_document_record_version,
    expectedVersionRecordVersion: value.expected_version_record_version,
    requestId,
    idempotencyKey,
  });
}

export async function parseEmptyDocumentCommand(request: Request): Promise<void> {
  const value = await exactJson(request);
  if (!hasExactKeys(value, []) || request.headers.has("idempotency-key")) invalidTransfer();
}

export function documentCollectionData(value: DocumentCollectionView): JsonValue {
  return Object.freeze({ documents: value.documents.map(documentData) });
}

export function documentDetailData(value: CaseDocumentView): JsonValue {
  return Object.freeze({ document: documentData(value) });
}

export function documentAcknowledgementData(value: DocumentAcknowledgement): JsonValue {
  return Object.freeze({ id: value.id, record_version: value.recordVersion });
}

export function documentVersionAcknowledgementData(
  value: DocumentVersionAcknowledgement,
): JsonValue {
  return Object.freeze({ id: value.id, record_version: value.recordVersion });
}

export function documentUploadIntentData(value: DocumentUploadIntentResult): JsonValue {
  return Object.freeze({
    method: value.method,
    expires_at_ms: value.expiresAtMs,
    url: value.url,
    headers: Object.freeze({
      "content-type": value.headers["content-type"],
      "x-amz-checksum-sha256": value.headers["x-amz-checksum-sha256"],
    }),
  });
}

export function documentDownloadIntentData(value: DocumentDownloadIntentResult): JsonValue {
  return Object.freeze({
    method: value.method,
    expires_at_ms: value.expiresAtMs,
    url: value.url,
    download_name: value.downloadName,
  });
}

export function documentData(value: CaseDocumentView): JsonValue {
  return Object.freeze({
    id: value.id,
    case_id: value.caseId,
    case_number: value.caseNumber,
    display_name: value.displayName,
    classification: value.classification,
    lifecycle_state: value.lifecycleState,
    latest_version_state: value.latestVersionState,
    pending_upload: value.pendingUpload === null
      ? null
      : Object.freeze({
          id: value.pendingUpload.id,
          record_version: value.pendingUpload.recordVersion,
        }),
    has_active_version: value.hasActiveVersion,
    record_version: value.recordVersion,
    updated_at: value.updatedAt,
  });
}

export function mapDocumentWorkspaceError(error: unknown): unknown {
  if (isDocumentWorkspaceRuntimeUnavailable(error)) return createApiError("SERVICE_UNAVAILABLE");
  if (!isDocumentWorkspaceError(error)) return error;
  switch (error.code) {
    case "DOCUMENT_WORKSPACE_FORBIDDEN":
      return createApiError("FORBIDDEN");
    case "DOCUMENT_WORKSPACE_INVALID":
      return createApiError("VALIDATION_FAILED");
    case "DOCUMENT_WORKSPACE_NOT_FOUND":
      return createApiError("NOT_FOUND");
    case "DOCUMENT_WORKSPACE_CONFLICT":
      return createApiError("CONFLICT");
    case "DOCUMENT_WORKSPACE_UNAVAILABLE":
      return createApiError("SERVICE_UNAVAILABLE");
  }
}

export function mapDocumentTransferError(error: unknown): unknown {
  if (isDocumentTransferRuntimeUnavailable(error)) return createApiError("SERVICE_UNAVAILABLE");
  if (!isDocumentTransferError(error)) return error;
  switch (error.code) {
    case "DOCUMENT_TRANSFER_FORBIDDEN":
      return createApiError("FORBIDDEN");
    case "DOCUMENT_TRANSFER_INVALID":
      return createApiError("VALIDATION_FAILED");
    case "DOCUMENT_TRANSFER_NOT_FOUND":
      return createApiError("NOT_FOUND");
    case "DOCUMENT_TRANSFER_STALE_VERSION":
      return createApiError("STALE_VERSION");
    case "DOCUMENT_TRANSFER_CONFLICT":
    case "DOCUMENT_TRANSFER_INTENT_EXPIRED":
    case "DOCUMENT_TRANSFER_INTENT_MISMATCH":
      return createApiError("CONFLICT");
    case "DOCUMENT_TRANSFER_UNAVAILABLE":
      return createApiError("SERVICE_UNAVAILABLE");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

async function exactJson(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") {
    invalidTransfer();
  }
  let text: string;
  let value: unknown;
  try {
    text = await request.text();
    assertUniqueTopLevelJsonKeys(text);
    value = JSON.parse(text) as unknown;
  } catch {
    invalidTransfer();
  }
  if (!isRecord(value)) invalidTransfer();
  return value;
}

function assertUniqueTopLevelJsonKeys(text: string): void {
  let index = skipJsonWhitespace(text, 0);
  if (text[index] !== "{") throw new SyntaxError("Expected JSON object.");
  index = skipJsonWhitespace(text, index + 1);
  const keys = new Set<string>();
  if (text[index] === "}") return;

  while (index < text.length) {
    if (text[index] !== '"') throw new SyntaxError("Expected JSON object key.");
    const keyEnd = jsonStringEnd(text, index);
    const key = JSON.parse(text.slice(index, keyEnd)) as unknown;
    if (typeof key !== "string" || keys.has(key)) throw new SyntaxError("Duplicate JSON key.");
    keys.add(key);
    index = skipJsonWhitespace(text, keyEnd);
    if (text[index] !== ":") throw new SyntaxError("Expected JSON object separator.");
    index = topLevelJsonValueEnd(text, skipJsonWhitespace(text, index + 1));
    index = skipJsonWhitespace(text, index);
    if (text[index] === "}") return;
    if (text[index] !== ",") throw new SyntaxError("Expected JSON member separator.");
    index = skipJsonWhitespace(text, index + 1);
  }
  throw new SyntaxError("Unterminated JSON object.");
}

function topLevelJsonValueEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{" || character === "[") depth += 1;
    else if (character === "}" || character === "]") {
      if (depth === 0) return index;
      depth -= 1;
    } else if (character === "," && depth === 0) {
      return index;
    }
  }
  return text.length;
}

function jsonStringEnd(text: string, start: number): number {
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) escaped = false;
    else if (character === "\\") escaped = true;
    else if (character === '"') return index + 1;
  }
  throw new SyntaxError("Unterminated JSON string.");
}

function skipJsonWhitespace(text: string, start: number): number {
  let index = start;
  while (index < text.length && /[\t\n\r ]/u.test(text[index] ?? "")) index += 1;
  return index;
}

function invalid(): never {
  throw new DocumentWorkspaceError("DOCUMENT_WORKSPACE_INVALID");
}

function invalidTransfer(): never {
  throw new DocumentTransferError("DOCUMENT_TRANSFER_INVALID");
}
