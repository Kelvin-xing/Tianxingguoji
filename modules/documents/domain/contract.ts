export const DOCUMENT_LIFECYCLE_STATES = Object.freeze([
  "active",
  "pending_delete",
  "deleted",
] as const);

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

export const SCAN_RESULT_STATES = Object.freeze([
  "queued",
  "running",
  "clean",
  "rejected",
  "failed",
] as const);

export const DOCUMENT_OBJECT_REGION = "ap-east-1" as const;
export const SOFT_DELETE_WINDOW_DAYS = 30;

export type DocumentLifecycleState = (typeof DOCUMENT_LIFECYCLE_STATES)[number];
export type DocumentVersionState = (typeof DOCUMENT_VERSION_STATES)[number];
export type ScanResultState = (typeof SCAN_RESULT_STATES)[number];
export type DocumentObjectRegion = typeof DOCUMENT_OBJECT_REGION;
export type DocumentOwnerKind = "student" | "case" | "task";
export type DocumentScanVerdict = "clean" | "malicious" | "failed";

export interface DocumentOwner {
  readonly kind: DocumentOwnerKind;
  readonly id: string;
}

export interface DocumentObjectReference {
  readonly region: DocumentObjectRegion;
  readonly bucket: string;
  readonly key: string;
  readonly versionId: string | null;
}

export interface DocumentRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly owner: DocumentOwner;
  readonly classification: string;
  readonly lifecycleState: DocumentLifecycleState;
  readonly activeVersionId: string | null;
  readonly legalHold: boolean;
  readonly legalHoldReason: string | null;
  readonly softDeletedAt: string | null;
  readonly retentionEndsAt: string | null;
  readonly recordVersion: number;
}

export interface DocumentVersionRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly documentId: string;
  readonly object: DocumentObjectReference;
  readonly checksumSha256: string;
  readonly sizeBytes: number;
  readonly detectedContentType: string;
  readonly uploadedBy: string;
  readonly state: DocumentVersionState;
  readonly revokedAt: string | null;
  readonly recordVersion: number;
}

export type DocumentDenialCode =
  | "DOCUMENT_ACTIVE_VERSION_INVALID"
  | "DOCUMENT_CONTEXT_MISMATCH"
  | "DOCUMENT_INTENT_EXPIRED"
  | "DOCUMENT_INTENT_MISMATCH"
  | "DOCUMENT_LEGAL_HOLD"
  | "DOCUMENT_LIVE_REFERENCE"
  | "DOCUMENT_NOT_ACTIVE"
  | "DOCUMENT_OBJECT_BUCKET_INVALID"
  | "DOCUMENT_OBJECT_KEY_INVALID"
  | "DOCUMENT_OBJECT_VERSION_INVALID"
  | "DOCUMENT_REGION_INVALID"
  | "DOCUMENT_RESTORE_REQUIRES_CLEAN_VERSION"
  | "DOCUMENT_RESTORE_REQUIRES_PENDING_DELETE"
  | "DOCUMENT_RETENTION_NOT_REACHED"
  | "DOCUMENT_RETENTION_POLICY_REQUIRED"
  | "DOCUMENT_SCAN_VERDICT_MISMATCH"
  | "DOCUMENT_SCAN_VERDICT_REQUIRED"
  | "DOCUMENT_SOFT_DELETE_REQUIRED"
  | "DOCUMENT_SOFT_DELETE_WINDOW_ACTIVE"
  | "DOCUMENT_SOFT_DELETE_WINDOW_EXPIRED"
  | "DOCUMENT_STALE_VERSION"
  | "DOCUMENT_UPLOAD_VERSION_STATE_INVALID"
  | "DOCUMENT_VERSION_NOT_AVAILABLE"
  | "DOCUMENT_VERSION_REVOKED"
  | "DOCUMENT_VERSION_TRANSITION_INVALID"
  | "DOCUMENT_PURGE_REQUIRES_FOUNDER";

export type DocumentDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code: DocumentDenialCode };

export class DocumentContractError extends Error {
  readonly code: DocumentDenialCode;

  constructor(code: DocumentDenialCode, message = code) {
    super(message);
    this.name = "DocumentContractError";
    this.code = code;
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const OBJECT_KEY_PATTERN =
  /^documents\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/versions\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SOFT_DELETE_WINDOW_MS = SOFT_DELETE_WINDOW_DAYS * 24 * 60 * 60 * 1000;

function isUuid(value: string): boolean {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isSha256(value: string): boolean {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function timestampMs(value: string): number {
  const valueMs = Date.parse(value);
  if (!Number.isFinite(valueMs)) throw new DocumentContractError("DOCUMENT_INTENT_EXPIRED");
  return valueMs;
}

function contextMatches(document: DocumentRecord, version: DocumentVersionRecord): boolean {
  return (
    document.organizationId === version.organizationId &&
    document.id === version.documentId
  );
}

function cleanVersionDecision(
  document: DocumentRecord,
  version: DocumentVersionRecord,
  allowPendingDelete: boolean,
): DocumentDecision {
  if (!contextMatches(document, version)) {
    return { allowed: false, code: "DOCUMENT_CONTEXT_MISMATCH" };
  }
  if (!allowPendingDelete && document.lifecycleState !== "active") {
    return { allowed: false, code: "DOCUMENT_NOT_ACTIVE" };
  }
  if (version.state !== "available") {
    return { allowed: false, code: "DOCUMENT_VERSION_NOT_AVAILABLE" };
  }
  if (version.revokedAt !== null) {
    return { allowed: false, code: "DOCUMENT_VERSION_REVOKED" };
  }
  const objectDecision = validateDocumentObjectReference(version, version.object.bucket);
  if (!objectDecision.allowed) return objectDecision;
  return { allowed: true };
}

export function createOpaqueDocumentObjectKey(documentId: string, versionId: string): string {
  if (!isUuid(documentId) || !isUuid(versionId)) {
    throw new DocumentContractError("DOCUMENT_OBJECT_KEY_INVALID");
  }
  return `documents/${documentId.toLowerCase()}/versions/${versionId.toLowerCase()}`;
}

export function isOpaqueDocumentObjectKey(value: string): boolean {
  return typeof value === "string" && OBJECT_KEY_PATTERN.test(value);
}

export function validateDocumentObjectReference(
  version: DocumentVersionRecord,
  expectedBucket: string,
): DocumentDecision {
  if (version.object.region !== DOCUMENT_OBJECT_REGION) {
    return { allowed: false, code: "DOCUMENT_REGION_INVALID" };
  }
  if (version.object.bucket !== expectedBucket || expectedBucket.trim() === "") {
    return { allowed: false, code: "DOCUMENT_OBJECT_BUCKET_INVALID" };
  }
  if (
    !isOpaqueDocumentObjectKey(version.object.key) ||
    version.object.key !== createOpaqueDocumentObjectKey(version.documentId, version.id)
  ) {
    return { allowed: false, code: "DOCUMENT_OBJECT_KEY_INVALID" };
  }
  if (
    version.object.versionId !== null &&
    (version.object.versionId.trim() === "" || /\s/.test(version.object.versionId))
  ) {
    return { allowed: false, code: "DOCUMENT_OBJECT_VERSION_INVALID" };
  }
  return { allowed: true };
}

export function evaluateDocumentVersionActivation(input: {
  readonly document: DocumentRecord;
  readonly version: DocumentVersionRecord;
}): DocumentDecision {
  return cleanVersionDecision(input.document, input.version, false);
}

export function evaluateDocumentVersionDownload(input: {
  readonly document: DocumentRecord;
  readonly version: DocumentVersionRecord;
}): DocumentDecision {
  return evaluateDocumentVersionActivation(input);
}

const VERSION_TRANSITIONS: Readonly<Record<DocumentVersionState, readonly DocumentVersionState[]>> =
  Object.freeze({
    pending_upload: ["quarantined"],
    quarantined: ["scanning"],
    scanning: ["available", "rejected", "scan_failed"],
    available: ["superseded", "pending_delete", "deleted"],
    rejected: ["deleted"],
    scan_failed: ["scanning"],
    superseded: ["pending_delete", "deleted"],
    pending_delete: ["deleted"],
    deleted: [],
  });

export function evaluateDocumentVersionTransition(input: {
  readonly from: DocumentVersionState;
  readonly to: DocumentVersionState;
  readonly scanVerdict?: DocumentScanVerdict;
}): DocumentDecision {
  if (!VERSION_TRANSITIONS[input.from].includes(input.to)) {
    return { allowed: false, code: "DOCUMENT_VERSION_TRANSITION_INVALID" };
  }
  if (input.from !== "scanning") return { allowed: true };

  const expectedVerdict =
    input.to === "available"
      ? "clean"
      : input.to === "rejected"
        ? "malicious"
        : "failed";
  if (input.scanVerdict === undefined) {
    return { allowed: false, code: "DOCUMENT_SCAN_VERDICT_REQUIRED" };
  }
  if (input.scanVerdict !== expectedVerdict) {
    return { allowed: false, code: "DOCUMENT_SCAN_VERDICT_MISMATCH" };
  }
  return { allowed: true };
}

export function evaluateDocumentRestore(input: {
  readonly document: DocumentRecord;
  readonly version: DocumentVersionRecord;
  readonly now: string;
  readonly expectedRecordVersion: number;
}): DocumentDecision {
  if (input.document.recordVersion !== input.expectedRecordVersion) {
    return { allowed: false, code: "DOCUMENT_STALE_VERSION" };
  }
  if (input.document.lifecycleState !== "pending_delete") {
    return { allowed: false, code: "DOCUMENT_RESTORE_REQUIRES_PENDING_DELETE" };
  }
  if (input.document.softDeletedAt === null) {
    return { allowed: false, code: "DOCUMENT_SOFT_DELETE_REQUIRED" };
  }
  if (timestampMs(input.now) > timestampMs(input.document.softDeletedAt) + SOFT_DELETE_WINDOW_MS) {
    return { allowed: false, code: "DOCUMENT_SOFT_DELETE_WINDOW_EXPIRED" };
  }
  const versionDecision = cleanVersionDecision(input.document, input.version, true);
  if (!versionDecision.allowed) {
    if (
      versionDecision.code === "DOCUMENT_VERSION_NOT_AVAILABLE" ||
      versionDecision.code === "DOCUMENT_VERSION_REVOKED"
    ) {
      return { allowed: false, code: "DOCUMENT_RESTORE_REQUIRES_CLEAN_VERSION" };
    }
    return versionDecision;
  }
  return { allowed: true };
}

export function evaluateDocumentPurge(input: {
  readonly document: DocumentRecord;
  readonly now: string;
  readonly expectedRecordVersion: number;
  readonly hasLiveReferences: boolean;
  readonly founderApproved: boolean;
}): DocumentDecision {
  if (input.document.recordVersion !== input.expectedRecordVersion) {
    return { allowed: false, code: "DOCUMENT_STALE_VERSION" };
  }
  if (!input.founderApproved) {
    return { allowed: false, code: "DOCUMENT_PURGE_REQUIRES_FOUNDER" };
  }
  if (input.document.lifecycleState !== "pending_delete" || input.document.softDeletedAt === null) {
    return { allowed: false, code: "DOCUMENT_SOFT_DELETE_REQUIRED" };
  }
  if (input.document.legalHold) {
    return { allowed: false, code: "DOCUMENT_LEGAL_HOLD" };
  }
  if (input.hasLiveReferences) {
    return { allowed: false, code: "DOCUMENT_LIVE_REFERENCE" };
  }
  if (timestampMs(input.now) < timestampMs(input.document.softDeletedAt) + SOFT_DELETE_WINDOW_MS) {
    return { allowed: false, code: "DOCUMENT_SOFT_DELETE_WINDOW_ACTIVE" };
  }
  if (input.document.retentionEndsAt === null) {
    return { allowed: false, code: "DOCUMENT_RETENTION_POLICY_REQUIRED" };
  }
  if (timestampMs(input.now) < timestampMs(input.document.retentionEndsAt)) {
    return { allowed: false, code: "DOCUMENT_RETENTION_NOT_REACHED" };
  }
  return { allowed: true };
}

export function assertDocumentVersionIntegrity(version: DocumentVersionRecord): void {
  if (!isUuid(version.id) || !isUuid(version.documentId) || !isUuid(version.organizationId)) {
    throw new DocumentContractError("DOCUMENT_CONTEXT_MISMATCH");
  }
  if (!isSha256(version.checksumSha256)) {
    throw new DocumentContractError("DOCUMENT_OBJECT_KEY_INVALID");
  }
  if (!Number.isSafeInteger(version.sizeBytes) || version.sizeBytes < 0) {
    throw new DocumentContractError("DOCUMENT_OBJECT_KEY_INVALID");
  }
  if (version.detectedContentType.trim() === "") {
    throw new DocumentContractError("DOCUMENT_OBJECT_KEY_INVALID");
  }
}
