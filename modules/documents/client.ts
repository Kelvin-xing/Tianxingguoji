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
  "superseded",
  "pending_delete",
  "deleted",
] as const);

export type DocumentClassification = (typeof DOCUMENT_CLASSIFICATIONS)[number];
export type DocumentLifecycleState = (typeof DOCUMENT_LIFECYCLE_STATES)[number];
export type DocumentVersionState = (typeof DOCUMENT_VERSION_STATES)[number];

export interface DocumentListItem {
  readonly id: string;
  readonly case_id: string;
  readonly case_number: string;
  readonly display_name: string;
  readonly classification: DocumentClassification;
  readonly lifecycle_state: DocumentLifecycleState;
  readonly latest_version_state: DocumentVersionState | null;
  readonly has_active_version: boolean;
  readonly record_version: number;
  readonly updated_at: string;
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

export type DocumentFailureKind =
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "validation"
  | "conflict"
  | "unavailable";

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

export function classifyDocumentFailure(error: unknown): DocumentFailureKind {
  if (!(error instanceof ApiClientError)) return "unavailable";
  if (error.code === "UNAUTHENTICATED" || error.status === 401) return "unauthenticated";
  if (error.code === "FORBIDDEN" || error.status === 403) return "forbidden";
  if (error.code === "NOT_FOUND" || error.status === 404) return "not_found";
  if (error.code === "VALIDATION_FAILED" || error.status === 422) return "validation";
  if (error.code === "CONFLICT" || error.code === "STALE_VERSION" || error.status === 409) return "conflict";
  return "unavailable";
}

export function documentRegistrationFingerprint(input: RegisterCaseDocumentInput): string {
  return JSON.stringify(normalizeRegistration(input));
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
  if (latestVersionState === null && hasActiveVersion) {
    throw new TypeError("Document without a version cannot have an active version.");
  }
  return Object.freeze({
    id: uuid(record.id, "document.id"),
    case_id: uuid(record.case_id, "document.case_id"),
    case_number: boundedText(record.case_number, "document.case_number", 100),
    display_name: boundedText(record.display_name, "document.display_name", 200),
    classification: oneOf(record.classification, DOCUMENT_CLASSIFICATIONS, "document.classification"),
    lifecycle_state: oneOf(record.lifecycle_state, DOCUMENT_LIFECYCLE_STATES, "document.lifecycle_state"),
    latest_version_state: latestVersionState,
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

function normalizeRegistration(input: RegisterCaseDocumentInput): RegisterCaseDocumentInput {
  return Object.freeze({
    display_name: boundedText(input.display_name, "display_name", 200),
    classification: oneOf(input.classification, DOCUMENT_CLASSIFICATIONS, "classification"),
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
