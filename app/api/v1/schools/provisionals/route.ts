import { cookies } from "next/headers";

import { SESSION_COOKIE_NAME } from "@/modules/identity/server";
import {
  SchoolServiceError,
  type CreateProvisionalSchoolCommand,
} from "@/modules/schools/server";
import { SchoolRuntimeUnavailable, getSchoolRuntime } from "@/modules/schools/server";
import { IdentityRuntimeUnavailable, getIdentityRuntime } from "@/modules/identity/server";
import { IdentityServiceError } from "@/modules/identity/server";
import { createApiError, handleApiRequest } from "@/modules/shared/public";

const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handleApiRequest(request, async (requestContext) => {
    const command = await parseProvisionalCommand(request, requestContext.requestId);
    const cookieSecret = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
    if (!cookieSecret) throw createApiError("UNAUTHENTICATED");

    try {
      const actor = await getIdentityRuntime().service.requireSession({
        cookieSecret,
        sensitiveAction: true,
      });
      const result = await getSchoolRuntime().service.createProvisionalSchool({ actor, command });
      return {
        school_id: result.schoolId,
        status: result.status,
        record_version: result.recordVersion,
      };
    } catch (error) {
      throw mapSchoolError(error);
    }
  });
}

async function parseProvisionalCommand(
  request: Request,
  requestId: string,
): Promise<CreateProvisionalSchoolCommand> {
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

  const { identity, district, system, stage, reason } = body;
  if (
    typeof identity !== "string" ||
    typeof district !== "string" ||
    typeof system !== "string" ||
    typeof stage !== "string" ||
    typeof reason !== "string"
  ) {
    throw createApiError("VALIDATION_FAILED");
  }

  return { identity, district, system, stage, reason, requestId, idempotencyKey };
}

function mapSchoolError(error: unknown) {
  if (error instanceof IdentityRuntimeUnavailable || error instanceof SchoolRuntimeUnavailable) {
    return createApiError("SERVICE_UNAVAILABLE");
  }
  if (error instanceof IdentityServiceError) return createApiError("UNAUTHENTICATED");
  if (!(error instanceof SchoolServiceError)) return createApiError("SERVICE_UNAVAILABLE");

  switch (error.code) {
    case "SCHOOL_ADVISOR_REQUIRED":
      return createApiError("FORBIDDEN");
    case "SCHOOL_COMMAND_INVALID":
      return createApiError("VALIDATION_FAILED");
    case "SCHOOL_CHANGE_BASE_NOT_FOUND":
      return createApiError("NOT_FOUND");
    case "SCHOOL_CHANGE_BASE_STALE":
    case "SCHOOL_CHANGE_IDEMPOTENCY_KEY_REUSED":
    case "SCHOOL_CHANGE_IDEMPOTENCY_IN_PROGRESS":
      return createApiError("CONFLICT");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
