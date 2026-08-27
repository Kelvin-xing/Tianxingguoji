import {
  isCandidateListError,
} from "@/modules/cases/server";
import { ApiContractError, createApiError } from "@/modules/shared/public";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function assertCandidateListId(value: string): void {
  if (!UUID.test(value)) throw createApiError("INVALID_REQUEST");
}

export function requireCandidateListIdempotencyKey(request: Request): string {
  const value = request.headers.get("idempotency-key")?.trim();
  if (!value || !IDEMPOTENCY_KEY.test(value)) throw createApiError("INVALID_REQUEST");
  return value;
}

export async function readExactJson<const Fields extends readonly string[]>(
  request: Request,
  fields: Fields,
): Promise<Record<Fields[number], unknown>> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw createApiError("INVALID_REQUEST");
  }
  let body: unknown;
  try { body = await request.json(); } catch { throw createApiError("INVALID_REQUEST"); }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw createApiError("INVALID_REQUEST");
  }
  const keys = Object.keys(body).sort();
  const expected = [...fields].sort();
  if (keys.length !== expected.length || expected.some((field, index) => field !== keys[index])) {
    throw createApiError("INVALID_REQUEST");
  }
  return body as Record<Fields[number], unknown>;
}

export function mapCandidateListError(error: unknown): ApiContractError | unknown {
  if (error instanceof ApiContractError) return error;
  if (!isCandidateListError(error)) return error;
  switch (error.code) {
    case "CANDIDATE_LIST_INVALID": return createApiError("VALIDATION_FAILED");
    case "CASE_CLOSE_INVALID": return createApiError("VALIDATION_FAILED");
    case "CANDIDATE_LIST_FORBIDDEN": return createApiError("FORBIDDEN");
    case "CANDIDATE_LIST_NOT_FOUND": return createApiError("NOT_FOUND");
    case "CASE_CLOSE_NOT_FOUND": return createApiError("NOT_FOUND");
    case "CANDIDATE_LIST_STALE_VERSION": return createApiError("STALE_VERSION");
    case "CASE_CLOSE_STALE_VERSION": return createApiError("STALE_VERSION");
    case "CANDIDATE_LIST_CASE_NOT_ACTIVE":
    case "CANDIDATE_LIST_BACKGROUND_INCOMPLETE":
    case "CANDIDATE_LIST_SELECTION_BLOCKED":
    case "CANDIDATE_LIST_GUARDIAN_INVALID":
    case "CANDIDATE_LIST_IDEMPOTENCY_KEY_REUSED":
    case "CANDIDATE_LIST_IDEMPOTENCY_IN_PROGRESS":
    case "CANDIDATE_LIST_CONFLICT": return createApiError("CONFLICT");
    case "CASE_CLOSE_TARGETS_INCOMPLETE":
    case "CASE_CLOSE_TASKS_INCOMPLETE": return createApiError("CONFLICT");
  }
}
