import { cookies } from "next/headers";

import { SESSION_COOKIE_NAME } from "@/modules/identity/server";
import {
  AccessScopeError,
  type GrantCollaboratorScopeCommand,
} from "@/modules/access/server";
import {
  AccessScopeRuntimeUnavailable,
  getAccessScopeRuntime,
} from "@/modules/access/server";
import { IdentityRuntimeUnavailable, getIdentityRuntime } from "@/modules/identity/server";
import { IdentityServiceError } from "@/modules/identity/server";
import { createApiError, handleApiRequest } from "@/modules/shared/public";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { readonly params: Promise<{ readonly caseId: string }> },
): Promise<Response> {
  return handleApiRequest(request, async (requestContext) => {
    const { caseId } = await context.params;
    if (!UUID.test(caseId)) throw createApiError("INVALID_REQUEST");
    const command = await parseGrantCommand(request, requestContext.requestId);
    const cookieSecret = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
    if (!cookieSecret) throw createApiError("UNAUTHENTICATED");

    try {
      const identity = getIdentityRuntime();
      const actor = await identity.service.requireSession({
        cookieSecret,
        sensitiveAction: true,
      });
      const result = await getAccessScopeRuntime().service.grantCollaboratorScope({
        actor,
        caseId,
        command,
      });
      return {
        collaborator_id: result.collaboratorId,
        grant_id: result.grantId,
        scope: result.scope,
        capability: result.capability,
        status: result.status,
        starts_at_ms: result.startsAtMs,
        expires_at_ms: result.expiresAtMs,
        record_version: result.recordVersion,
      };
    } catch (error) {
      throw mapAccessScopeError(error);
    }
  });
}

async function parseGrantCommand(
  request: Request,
  requestId: string,
): Promise<GrantCollaboratorScopeCommand> {
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

  const collaboratorUserId = body.collaborator_user_id;
  const scope = body.scope;
  const capability = body.capability;
  const expiresAtMs = body.expires_at_ms ?? null;
  const requestReason = body.request_reason ?? null;
  if (
    typeof collaboratorUserId !== "string" ||
    typeof scope !== "string" ||
    typeof capability !== "string" ||
    (expiresAtMs !== null && typeof expiresAtMs !== "number") ||
    (requestReason !== null && typeof requestReason !== "string")
  ) {
    throw createApiError("INVALID_REQUEST");
  }

  return {
    collaboratorUserId,
    scope: scope as GrantCollaboratorScopeCommand["scope"],
    capability: capability as GrantCollaboratorScopeCommand["capability"],
    expiresAtMs,
    requestReason,
    requestId,
    idempotencyKey,
  };
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
