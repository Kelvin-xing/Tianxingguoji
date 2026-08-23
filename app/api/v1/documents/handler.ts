import {
  DocumentWorkspaceError,
  isDocumentWorkspaceError,
  isDocumentWorkspaceRuntimeUnavailable,
  type CaseDocumentView,
  type DocumentAcknowledgement,
  type DocumentCollectionView,
} from "../../../../modules/documents/server.ts";
import { createApiError, type JsonValue } from "../../../../modules/shared/public.ts";

const REGISTRATION_KEYS = ["classification", "display_name"] as const;

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

export function documentCollectionData(value: DocumentCollectionView): JsonValue {
  return Object.freeze({ documents: value.documents.map(documentData) });
}

export function documentDetailData(value: CaseDocumentView): JsonValue {
  return Object.freeze({ document: documentData(value) });
}

export function documentAcknowledgementData(value: DocumentAcknowledgement): JsonValue {
  return Object.freeze({ id: value.id, record_version: value.recordVersion });
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function invalid(): never {
  throw new DocumentWorkspaceError("DOCUMENT_WORKSPACE_INVALID");
}
