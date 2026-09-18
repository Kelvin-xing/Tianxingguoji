import { TrialMemberError } from "@/modules/access/server";
import { createApiError } from "@/modules/shared/public";

export async function parseTrialMemberCommand(request: Request) {
  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") throw createApiError("INVALID_REQUEST");
  const key = request.headers.get("idempotency-key")?.trim();
  if (!key || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(key)) throw createApiError("INVALID_REQUEST");
  let body: unknown;
  try { body = await request.json(); } catch { throw createApiError("INVALID_REQUEST"); }
  if (!body || typeof body !== "object" || Array.isArray(body)
    || Object.keys(body).sort().join(",") !== "categories,expected_record_version,level,status") throw createApiError("INVALID_REQUEST");
  const value = body as Record<string, unknown>;
  return { level: value.level, categories: value.categories, status: value.status,
    expectedRecordVersion: value.expected_record_version, idempotencyKey: key };
}
export function mapTrialMemberError(error: unknown): unknown {
  if (!(error instanceof TrialMemberError)) return error;
  switch (error.code) {
    case "FORBIDDEN": return createApiError("FORBIDDEN");
    case "INVALID": return createApiError("VALIDATION_FAILED");
    case "NOT_FOUND": return createApiError("NOT_FOUND");
    case "STALE_VERSION": return createApiError("STALE_VERSION");
    case "LAST_FOUNDER_REQUIRED":
    case "IDEMPOTENCY_CONFLICT": return createApiError("CONFLICT");
    default: return createApiError("SERVICE_UNAVAILABLE");
  }
}
