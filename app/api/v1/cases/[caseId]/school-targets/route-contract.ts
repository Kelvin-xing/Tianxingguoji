import { createApiError } from "../../../../../../modules/shared/public.ts";

const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CREATE_BODY_FIELDS = Object.freeze(["expected_resolution_sha256", "school_id"]);

export async function parseCreateSchoolTargetRequest(
  request: Request,
  requestId: string,
): Promise<{
  readonly schoolId: string;
  readonly command: Readonly<{
    expectedResolutionSha256: string;
    requestId: string;
    idempotencyKey: string;
  }>;
}> {
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
    throw createApiError("INVALID_REQUEST");
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw createApiError("INVALID_REQUEST");
  }
  if (!isRecord(body)) throw createApiError("INVALID_REQUEST");
  const fields = Object.keys(body).sort();
  if (fields.length !== CREATE_BODY_FIELDS.length ||
      fields.some((field, index) => field !== CREATE_BODY_FIELDS[index])) {
    throw createApiError("INVALID_REQUEST");
  }
  const schoolId = body.school_id;
  const expectedResolutionSha256 = body.expected_resolution_sha256;
  if (typeof schoolId !== "string" || typeof expectedResolutionSha256 !== "string") {
    throw createApiError("VALIDATION_FAILED");
  }
  return Object.freeze({
    schoolId,
    command: Object.freeze({ expectedResolutionSha256, requestId, idempotencyKey }),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
