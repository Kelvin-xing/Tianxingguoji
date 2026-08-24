import {
  ApiClientError,
  expectArray,
  expectBoolean,
  expectNullableString,
  expectNumber,
  expectRecord,
  expectString,
  requestApi,
} from "../../lib/api/client.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const SHA256_BASE64 = /^[A-Za-z0-9+/]{43}=$/;

export const DOCUMENT_UPLOAD_MAX_BYTES = 10_485_760;
export const DOCUMENT_SCAN_POLL_TIMEOUT_MS = 90_000;
export const DOCUMENT_UPLOAD_CONTENT_TYPES = Object.freeze([
  "application/pdf",
  "image/jpeg",
  "image/png",
] as const);

export const DOCUMENT_CLASSIFICATIONS = Object.freeze([
  "identity_and_case_evidence",
  "operational_attachment",
] as const);
export const DOCUMENT_LIFECYCLE_STATES = Object.freeze(["active", "pending_delete"] as const);
export const DOCUMENT_VERSION_STATES = Object.freeze([
  "pending_upload",
  "quarantined",
  "scanning",
  "available",
  "rejected",
  "scan_failed",
  "abandoned",
  "superseded",
  "pending_delete",
  "deleted",
] as const);

export type DocumentClassification = (typeof DOCUMENT_CLASSIFICATIONS)[number];
export type DocumentLifecycleState = (typeof DOCUMENT_LIFECYCLE_STATES)[number];
export type DocumentVersionState = (typeof DOCUMENT_VERSION_STATES)[number];
export type DocumentUploadContentType = (typeof DOCUMENT_UPLOAD_CONTENT_TYPES)[number];

export interface DocumentListItem {
  readonly id: string;
  readonly case_id: string;
  readonly case_number: string;
  readonly display_name: string;
  readonly classification: DocumentClassification;
  readonly lifecycle_state: DocumentLifecycleState;
  readonly latest_version_state: DocumentVersionState | null;
  readonly pending_upload: DocumentPendingUpload | null;
  readonly has_active_version: boolean;
  readonly record_version: number;
  readonly updated_at: string;
}

export interface DocumentPendingUpload {
  readonly id: string;
  readonly record_version: number;
}

export interface DocumentListResult {
  readonly documents: readonly DocumentListItem[];
}

export interface DocumentDetailResult {
  readonly document: DocumentListItem;
}

export interface RegisterCaseDocumentInput {
  readonly display_name: string;
  readonly classification: DocumentClassification;
}

export interface DocumentWriteReceipt {
  readonly id: string;
  readonly record_version: number;
}

export interface CreateDocumentVersionInput {
  readonly checksum_sha256: string;
  readonly size_bytes: number;
  readonly content_type: DocumentUploadContentType;
  readonly expected_document_record_version: number;
}

export interface AbandonDocumentVersionInput {
  readonly expected_document_record_version: number;
  readonly expected_version_record_version: number;
}

export interface DocumentFileDigest {
  readonly checksum_sha256: string;
  readonly checksum_base64: string;
  readonly size_bytes: number;
  readonly content_type: DocumentUploadContentType;
}

export interface DocumentUploadIntent {
  readonly method: "PUT";
  readonly expires_at_ms: number;
  readonly url: string;
  readonly headers: Readonly<{
    readonly "content-type": DocumentUploadContentType;
    readonly "x-amz-checksum-sha256": string;
  }>;
}

export interface DocumentDownloadIntent {
  readonly method: "GET";
  readonly expires_at_ms: number;
  readonly url: string;
  readonly download_name: "document.pdf" | "document.jpg" | "document.png";
}

export interface DocumentPollOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly onAuthoritativeChange?: (document: DocumentListItem) => void;
}

export type DocumentFailureKind =
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "validation"
  | "stale"
  | "conflict"
  | "timeout"
  | "unavailable";

export class DocumentTransferError extends Error {
  readonly kind: Extract<DocumentFailureKind, "validation" | "conflict" | "timeout" | "unavailable">;
  readonly recoverable: boolean;

  constructor(kind: DocumentTransferError["kind"], recoverable = false) {
    super("Document transfer failed.");
    this.name = "DocumentTransferError";
    this.kind = kind;
    this.recoverable = recoverable;
  }
}

export function listDocuments(signal?: AbortSignal): Promise<DocumentListResult> {
  return requestApi({ path: "/api/v1/documents", signal }, decodeDocumentList);
}

export function listCaseDocuments(caseId: string, signal?: AbortSignal): Promise<DocumentListResult> {
  assertUuid(caseId, "caseId");
  return requestApi(
    { path: `/api/v1/cases/${caseId}/documents`, signal },
    (value) => decodeDocumentList(value, caseId),
  );
}

export function getCaseDocument(
  caseId: string,
  documentId: string,
  signal?: AbortSignal,
): Promise<DocumentDetailResult> {
  assertUuid(caseId, "caseId");
  assertUuid(documentId, "documentId");
  return requestApi(
    { path: `/api/v1/cases/${caseId}/documents/${documentId}`, signal },
    (value) => decodeDocumentDetail(value, caseId, documentId),
  );
}

export function registerCaseDocument(
  caseId: string,
  input: RegisterCaseDocumentInput,
  idempotencyKey: string,
): Promise<DocumentWriteReceipt> {
  assertUuid(caseId, "caseId");
  const normalized = normalizeRegistration(input);
  assertIdempotencyKey(idempotencyKey);
  return requestApi(
    {
      path: `/api/v1/cases/${caseId}/documents`,
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: {
        display_name: normalized.display_name,
        classification: normalized.classification,
      },
    },
    (value) => decodeWriteReceipt(value, 1),
  );
}

export function createDocumentVersion(
  caseId: string,
  documentId: string,
  input: CreateDocumentVersionInput,
  idempotencyKey: string,
): Promise<DocumentWriteReceipt> {
  assertUuid(caseId, "caseId");
  assertUuid(documentId, "documentId");
  const normalized = normalizeVersionInput(input);
  assertIdempotencyKey(idempotencyKey);
  return requestApi(
    {
      path: `/api/v1/cases/${caseId}/documents/${documentId}/versions`,
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: {
        checksum_sha256: normalized.checksum_sha256,
        size_bytes: normalized.size_bytes,
        content_type: normalized.content_type,
        expected_document_record_version: normalized.expected_document_record_version,
      },
    },
    (value) => decodeWriteReceipt(value, 1),
  );
}

export async function issueDocumentUploadIntent(
  caseId: string,
  documentId: string,
  versionId: string,
  expectedRecordVersion: number,
  expectedFile: Pick<DocumentFileDigest, "content_type" | "checksum_base64">,
): Promise<DocumentUploadIntent> {
  assertUuid(caseId, "caseId");
  assertUuid(documentId, "documentId");
  assertUuid(versionId, "versionId");
  const version = positiveInteger(expectedRecordVersion, "expected_record_version");
  const intent = await requestApi(
    {
      path: `/api/v1/cases/${caseId}/documents/${documentId}/versions/${versionId}/upload-intents`,
      method: "POST",
      body: { expected_record_version: version },
    },
    decodeUploadIntent,
  );
  if (intent.headers["content-type"] !== expectedFile.content_type
    || intent.headers["x-amz-checksum-sha256"] !== expectedFile.checksum_base64) {
    throw new DocumentTransferError("conflict");
  }
  return intent;
}

export function abandonDocumentVersion(
  caseId: string,
  documentId: string,
  versionId: string,
  input: AbandonDocumentVersionInput,
  idempotencyKey: string,
): Promise<DocumentWriteReceipt> {
  assertUuid(caseId, "caseId");
  assertUuid(documentId, "documentId");
  assertUuid(versionId, "versionId");
  const normalized = normalizeAbandonmentInput(input);
  assertIdempotencyKey(idempotencyKey);
  return requestApi(
    {
      path: `/api/v1/cases/${caseId}/documents/${documentId}/versions/${versionId}/abandonments`,
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: {
        expected_document_record_version: normalized.expected_document_record_version,
        expected_version_record_version: normalized.expected_version_record_version,
      },
    },
    (value) => decodeWriteReceipt(value, normalized.expected_version_record_version + 1),
  );
}

export function issueDocumentDownloadIntent(
  caseId: string,
  documentId: string,
): Promise<DocumentDownloadIntent> {
  assertUuid(caseId, "caseId");
  assertUuid(documentId, "documentId");
  return requestApi(
    {
      path: `/api/v1/cases/${caseId}/documents/${documentId}/download-intents`,
      method: "POST",
      body: {},
    },
    decodeDownloadIntent,
  );
}

export function validateDocumentUploadFile(file: Pick<Blob, "size" | "type">): DocumentUploadContentType {
  if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > DOCUMENT_UPLOAD_MAX_BYTES) {
    throw new DocumentTransferError("validation");
  }
  if (!DOCUMENT_UPLOAD_CONTENT_TYPES.some((contentType) => contentType === file.type)) {
    throw new DocumentTransferError("validation");
  }
  return file.type as DocumentUploadContentType;
}

export async function digestDocumentUploadFile(file: Blob): Promise<DocumentFileDigest> {
  const contentType = validateDocumentUploadFile(file);
  if (!globalThis.crypto?.subtle) throw new DocumentTransferError("unavailable");
  let digest: ArrayBuffer;
  try {
    digest = await globalThis.crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  } catch {
    throw new DocumentTransferError("unavailable");
  }
  const bytes = new Uint8Array(digest);
  const checksumHex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const checksumBase64 = globalThis.btoa(String.fromCharCode(...bytes));
  if (!SHA256_HEX.test(checksumHex) || !SHA256_BASE64.test(checksumBase64)) {
    throw new DocumentTransferError("unavailable");
  }
  return Object.freeze({
    checksum_sha256: checksumHex,
    checksum_base64: checksumBase64,
    size_bytes: file.size,
    content_type: contentType,
  });
}

export async function putDocumentBytes(intent: DocumentUploadIntent, file: Blob): Promise<void> {
  const contentType = validateDocumentUploadFile(file);
  if (contentType !== intent.headers["content-type"]) throw new DocumentTransferError("validation");
  assertIntentFresh(intent.expires_at_ms);
  try {
    const response = await fetch(intent.url, {
      method: "PUT",
      headers: intent.headers,
      body: file,
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
    });
    if (!response.ok) throw new DocumentTransferError(response.status === 403 ? "conflict" : "unavailable", true);
  } catch (error) {
    if (error instanceof DocumentTransferError) throw error;
    throw new DocumentTransferError("unavailable");
  }
}

export async function fetchDocumentBytes(intent: DocumentDownloadIntent): Promise<Blob> {
  assertIntentFresh(intent.expires_at_ms);
  try {
    const response = await fetch(intent.url, {
      method: "GET",
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
    });
    if (!response.ok) throw new DocumentTransferError(response.status === 403 ? "conflict" : "unavailable");
    const blob = await response.blob();
    if (blob.size < 1 || blob.size > DOCUMENT_UPLOAD_MAX_BYTES) throw new DocumentTransferError("unavailable");
    return blob;
  } catch (error) {
    if (error instanceof DocumentTransferError) throw error;
    throw new DocumentTransferError("unavailable");
  }
}

export async function pollCaseDocumentUntilSettled(
  caseId: string,
  documentId: string,
  options: DocumentPollOptions = {},
): Promise<DocumentDetailResult> {
  const timeoutMs = options.timeoutMs ?? DOCUMENT_SCAN_POLL_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? 1_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DOCUMENT_SCAN_POLL_TIMEOUT_MS
    || !Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > timeoutMs) {
    throw new DocumentTransferError("validation");
  }
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    if (options.signal?.aborted) throw new DocumentTransferError("unavailable");
    const detail = await getCaseDocument(caseId, documentId, options.signal);
    options.onAuthoritativeChange?.(detail.document);
    const state = detail.document.latest_version_state;
    if (state === "available" || state === "rejected" || state === "scan_failed") return detail;
    if (state !== "pending_upload" && state !== "quarantined" && state !== "scanning") {
      throw new DocumentTransferError("conflict");
    }
    const remaining = timeoutMs - (Date.now() - startedAt);
    if (remaining <= 0) break;
    await abortableDelay(Math.min(intervalMs, remaining), options.signal);
  }
  throw new DocumentTransferError("timeout");
}

export function classifyDocumentFailure(error: unknown): DocumentFailureKind {
  if (error instanceof DocumentTransferError) return error.kind;
  if (!(error instanceof ApiClientError)) return "unavailable";
  if (error.code === "UNAUTHENTICATED" || error.status === 401) return "unauthenticated";
  if (error.code === "FORBIDDEN" || error.status === 403) return "forbidden";
  if (error.code === "NOT_FOUND" || error.status === 404) return "not_found";
  if (error.code === "VALIDATION_FAILED" || error.status === 422) return "validation";
  if (error.code === "STALE_VERSION") return "stale";
  if (error.code === "CONFLICT" || error.status === 409) return "conflict";
  if (error.code === "REQUEST_TIMEOUT") return "timeout";
  return "unavailable";
}

export function documentRegistrationFingerprint(input: RegisterCaseDocumentInput): string {
  return JSON.stringify(normalizeRegistration(input));
}

export function documentVersionFingerprint(input: CreateDocumentVersionInput): string {
  return JSON.stringify(normalizeVersionInput(input));
}

export function documentAbandonmentFingerprint(input: AbandonDocumentVersionInput): string {
  return JSON.stringify(normalizeAbandonmentInput(input));
}

export class DocumentIdempotencyAttempt {
  private readonly createKey: () => string;
  private fingerprint: string | null = null;
  private key: string | null = null;

  constructor(createKey: () => string = () => globalThis.crypto.randomUUID()) {
    this.createKey = createKey;
  }

  keyFor(fingerprint: string): string {
    if (fingerprint.trim() === "") throw new TypeError("Invalid Document fingerprint.");
    if (fingerprint !== this.fingerprint) {
      this.fingerprint = fingerprint;
      this.key = null;
    }
    if (this.key === null) {
      const next = this.createKey();
      assertIdempotencyKey(next);
      this.key = next;
    }
    return this.key;
  }

  rotate(): void {
    this.key = null;
  }

  complete(): void {
    this.fingerprint = null;
    this.key = null;
  }
}

function decodeDocumentList(value: unknown, expectedCaseId?: string): DocumentListResult {
  const record = exactRecord(value, ["documents"]);
  const documents = expectArray(record.documents, decodeDocumentItem);
  if (documents.length > 100) throw new TypeError("Document list exceeds the contract limit.");
  assertUnique(documents.map((document) => document.id), "document.id");
  if (expectedCaseId !== undefined && documents.some((document) => document.case_id !== expectedCaseId)) {
    throw new TypeError("Case Document list contains another Case.");
  }
  assertCanonicalOrder(documents);
  return Object.freeze({ documents: Object.freeze([...documents]) });
}

function decodeDocumentDetail(value: unknown, expectedCaseId: string, expectedDocumentId: string): DocumentDetailResult {
  const record = exactRecord(value, ["document"]);
  const document = decodeDocumentItem(record.document);
  if (document.case_id !== expectedCaseId || document.id !== expectedDocumentId) {
    throw new TypeError("Document detail authority mismatch.");
  }
  return Object.freeze({ document });
}

function decodeDocumentItem(value: unknown): DocumentListItem {
  const record = exactRecord(value, [
    "id",
    "case_id",
    "case_number",
    "display_name",
    "classification",
    "lifecycle_state",
    "latest_version_state",
    "pending_upload",
    "has_active_version",
    "record_version",
    "updated_at",
  ]);
  const latestVersionState = nullableOneOf(
    expectNullableString(record.latest_version_state),
    DOCUMENT_VERSION_STATES,
    "document.latest_version_state",
  );
  const hasActiveVersion = expectBoolean(record.has_active_version);
  const pendingUpload = record.pending_upload === null ? null : decodePendingUpload(record.pending_upload);
  if (latestVersionState === null && hasActiveVersion) {
    throw new TypeError("Document without a version cannot have an active version.");
  }
  if ((latestVersionState === "pending_upload") !== (pendingUpload !== null)) {
    throw new TypeError("Document pending upload authority mismatch.");
  }
  return Object.freeze({
    id: uuid(record.id, "document.id"),
    case_id: uuid(record.case_id, "document.case_id"),
    case_number: boundedText(record.case_number, "document.case_number", 100),
    display_name: boundedText(record.display_name, "document.display_name", 200),
    classification: oneOf(record.classification, DOCUMENT_CLASSIFICATIONS, "document.classification"),
    lifecycle_state: oneOf(record.lifecycle_state, DOCUMENT_LIFECYCLE_STATES, "document.lifecycle_state"),
    latest_version_state: latestVersionState,
    pending_upload: pendingUpload,
    has_active_version: hasActiveVersion,
    record_version: positiveInteger(record.record_version, "document.record_version"),
    updated_at: isoTimestamp(record.updated_at, "document.updated_at"),
  });
}

function decodeWriteReceipt(value: unknown, expectedVersion: number): DocumentWriteReceipt {
  const record = exactRecord(value, ["id", "record_version"]);
  const receipt = Object.freeze({
    id: uuid(record.id, "receipt.id"),
    record_version: positiveInteger(record.record_version, "receipt.record_version"),
  });
  if (receipt.record_version !== expectedVersion) throw new TypeError("Document receipt version mismatch.");
  return receipt;
}

function decodeUploadIntent(value: unknown): DocumentUploadIntent {
  const record = exactRecord(value, ["method", "expires_at_ms", "url", "headers"]);
  if (record.method !== "PUT") throw new TypeError("Invalid upload method.");
  const headers = exactRecord(record.headers, ["content-type", "x-amz-checksum-sha256"]);
  const contentType = oneOf(headers["content-type"], DOCUMENT_UPLOAD_CONTENT_TYPES, "upload.content-type");
  const checksum = expectString(headers["x-amz-checksum-sha256"]);
  if (!SHA256_BASE64.test(checksum)) throw new TypeError("Invalid upload checksum.");
  return Object.freeze({
    method: "PUT",
    expires_at_ms: futureExpiry(record.expires_at_ms, 600_000, "upload.expires_at_ms"),
    url: privateCapabilityUrl(record.url, "upload.url"),
    headers: Object.freeze({ "content-type": contentType, "x-amz-checksum-sha256": checksum }),
  });
}

function decodePendingUpload(value: unknown): DocumentPendingUpload {
  const record = exactRecord(value, ["id", "record_version"]);
  return Object.freeze({
    id: uuid(record.id, "document.pending_upload.id"),
    record_version: positiveInteger(record.record_version, "document.pending_upload.record_version"),
  });
}

function decodeDownloadIntent(value: unknown): DocumentDownloadIntent {
  const record = exactRecord(value, ["method", "expires_at_ms", "url", "download_name"]);
  if (record.method !== "GET") throw new TypeError("Invalid download method.");
  const downloadName = oneOf(
    record.download_name,
    ["document.pdf", "document.jpg", "document.png"] as const,
    "download.download_name",
  );
  return Object.freeze({
    method: "GET",
    expires_at_ms: futureExpiry(record.expires_at_ms, 300_000, "download.expires_at_ms"),
    url: privateCapabilityUrl(record.url, "download.url"),
    download_name: downloadName,
  });
}

function normalizeRegistration(input: RegisterCaseDocumentInput): RegisterCaseDocumentInput {
  return Object.freeze({
    display_name: boundedText(input.display_name, "display_name", 200),
    classification: oneOf(input.classification, DOCUMENT_CLASSIFICATIONS, "classification"),
  });
}

function normalizeVersionInput(input: CreateDocumentVersionInput): CreateDocumentVersionInput {
  if (!SHA256_HEX.test(input.checksum_sha256)) throw new TypeError("Invalid checksum_sha256.");
  if (!Number.isSafeInteger(input.size_bytes) || input.size_bytes < 1 || input.size_bytes > DOCUMENT_UPLOAD_MAX_BYTES) {
    throw new TypeError("Invalid size_bytes.");
  }
  return Object.freeze({
    checksum_sha256: input.checksum_sha256,
    size_bytes: input.size_bytes,
    content_type: oneOf(input.content_type, DOCUMENT_UPLOAD_CONTENT_TYPES, "content_type"),
    expected_document_record_version: positiveInteger(
      input.expected_document_record_version,
      "expected_document_record_version",
    ),
  });
}

function normalizeAbandonmentInput(input: AbandonDocumentVersionInput): AbandonDocumentVersionInput {
  return Object.freeze({
    expected_document_record_version: positiveInteger(
      input.expected_document_record_version,
      "expected_document_record_version",
    ),
    expected_version_record_version: positiveInteger(
      input.expected_version_record_version,
      "expected_version_record_version",
    ),
  });
}

function assertCanonicalOrder(documents: readonly DocumentListItem[]): void {
  for (let index = 1; index < documents.length; index += 1) {
    const previous = documents[index - 1]!;
    const current = documents[index]!;
    const previousMs = Date.parse(previous.updated_at);
    const currentMs = Date.parse(current.updated_at);
    if (previousMs < currentMs || (previousMs === currentMs && previous.id.localeCompare(current.id) > 0)) {
      throw new TypeError("Document list order is not canonical.");
    }
  }
}

function exactRecord(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  const record = expectRecord(value);
  const actual = Object.keys(record);
  if (actual.length !== keys.length || keys.some((key) => !Object.hasOwn(record, key))) {
    throw new TypeError("Invalid Document response shape.");
  }
  return record;
}

function uuid(value: unknown, field: string): string {
  const text = expectString(value);
  if (!UUID.test(text)) throw new TypeError(`Invalid ${field}.`);
  return text;
}

function assertUuid(value: string, field: string): void {
  if (!UUID.test(value)) throw new TypeError(`Invalid ${field}.`);
}

function boundedText(value: unknown, field: string, max: number): string {
  const text = expectString(value);
  if (text.trim() !== text || text.length < 1 || text.length > max) throw new TypeError(`Invalid ${field}.`);
  return text;
}

function positiveInteger(value: unknown, field: string): number {
  const number = expectNumber(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new TypeError(`Invalid ${field}.`);
  return number;
}

function isoTimestamp(value: unknown, field: string): string {
  const text = expectString(value);
  const date = new Date(text);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== text) throw new TypeError(`Invalid ${field}.`);
  return text;
}

function oneOf<const T extends readonly string[]>(value: unknown, values: T, field: string): T[number] {
  const text = expectString(value);
  if (!values.includes(text)) throw new TypeError(`Invalid ${field}.`);
  return text as T[number];
}

function nullableOneOf<const T extends readonly string[]>(value: string | null, values: T, field: string): T[number] | null {
  return value === null ? null : oneOf(value, values, field);
}

function assertUnique(values: readonly string[], field: string): void {
  if (new Set(values).size !== values.length) throw new TypeError(`Duplicate ${field}.`);
}

function assertIdempotencyKey(value: string): void {
  if (!IDEMPOTENCY_KEY.test(value)) throw new TypeError("Invalid Idempotency-Key.");
}

function futureExpiry(value: unknown, maxTtlMs: number, field: string): number {
  const expiry = positiveInteger(value, field);
  const now = Date.now();
  if (expiry <= now || expiry > now + maxTtlMs) throw new TypeError(`Invalid ${field}.`);
  return expiry;
}

function privateCapabilityUrl(value: unknown, field: string): string {
  const text = expectString(value);
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new TypeError(`Invalid ${field}.`);
  }
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]";
  if ((parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback))
    || parsed.username !== "" || parsed.password !== "" || parsed.hash !== "") {
    throw new TypeError(`Invalid ${field}.`);
  }
  return text;
}

function assertIntentFresh(expiresAtMs: number): void {
  if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= Date.now()) {
    throw new DocumentTransferError("conflict", true);
  }
}

async function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolveDelay, rejectDelay) => {
    if (signal?.aborted) {
      rejectDelay(new DocumentTransferError("unavailable"));
      return;
    }
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolveDelay();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timeout);
      rejectDelay(new DocumentTransferError("unavailable"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
