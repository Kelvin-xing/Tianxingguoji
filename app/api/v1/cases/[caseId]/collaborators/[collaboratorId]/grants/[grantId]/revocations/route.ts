import { cookies } from "next/headers";

import { SESSION_COOKIE_NAME } from "@/lib/auth/cookies";
import {
  AccessScopeError,
  type RevokeCollaboratorScopeCommand,
} from "@/modules/access/service";
import {
  AccessScopeRuntimeUnavailable,
  getAccessScopeRuntime,
} from "@/modules/access/runtime";
import { IdentityRuntimeUnavailable, getIdentityRuntime } from "@/modules/identity/runtime";
import { IdentityServiceError } from "@/modules/identity/service";
import { createApiError, handleApiRequest } from "@/modules/shared/api-contract";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: {
    readonly params: Promise<{
      readonly caseId: string;
      readonly collaboratorId: string;
      readonly grantId: string;
    }>;
  },
): Promise<Response> {
  return handleApiRequest(request, async (requestContext) => {
    const { caseId, collaboratorId, grantId } = await context.params;
    if (![caseId, collaboratorId, grantId].every((id) => UUID.test(id))) {
      throw createApiError("INVALID_REQUEST");
    }
    const command = await parseRevokeCommand(request, requestContext.requestId);
    const cookieSecret = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
    if (!cookieSecret) throw createApiError("UNAUTHENTICATED");

    try {
      const identity = getIdentityRuntime();
      const actor = await identity.service.requireSession({
        cookieSecret,
        sensitiveAction: true,
      });
      const result = await getAccessScopeRuntime().service.revokeCollaboratorScope({
        actor,
        caseId,
        collaboratorId,
        grantId,
        command,
      });
      return {
        collaborator_id: result.collaboratorId,
        grant_id: result.grantId,
        status: result.status,
        record_version: result.recordVersion,
      };
    } catch (error) {
      throw mapAccessScopeError(error);
    }
  });
}

async function parseRevokeCommand(
  request: Request,
  requestId: string,
): Promise<RevokeCollaboratorScopeCommand> {
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

  const expectedRecordVersion = body.expected_record_version;
  const reason = body.reason;
  if (typeof expectedRecordVersion !== "number" || typeof reason !== "string") {
    throw createApiError("INVALID_REQUEST");
  }
  return { expectedRecordVersion, reason, requestId, idempotencyKey };
}

function mapAccessScopeError(error: unknown) {
  if (
    error instanceof IdentityRuntimeUnavailable ||
    error instanceof AccessScopeRuntimeUnavailable
  ) {
    return createApiError("SERVICE_UNAVAILABLE");
  }
  if (error instanceof IdentityServiceError) return createApiError("UNAUTHENTICATED");
  if (!(error instanceof AccessScopeError)) return createApiError("SERVICE_UNAVAILABLE");

  switch (error.code) {
    case "COLLABORATOR_SCOPE_INVALID":
    case "COLLABORATOR_TARGET_ADVISOR_REQUIRED":
      return createApiError("VALIDATION_FAILED");
    case "COLLABORATOR_PRIMARY_ADVISOR_REQUIRED":
      return createApiError("FORBIDDEN");
    case "COLLABORATOR_CASE_NOT_ACTIVE":
      return createApiError("NOT_FOUND");
    case "COLLABORATOR_SCOPE_STALE_VERSION":
      return createApiError("STALE_VERSION");
    case "COLLABORATOR_SCOPE_IDEMPOTENCY_KEY_REUSED":
    case "COLLABORATOR_SCOPE_IDEMPOTENCY_IN_PROGRESS":
    case "COLLABORATOR_SCOPE_DUPLICATE":
    case "COLLABORATOR_SCOPE_NOT_ACTIVE":
      return createApiError("CONFLICT");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
