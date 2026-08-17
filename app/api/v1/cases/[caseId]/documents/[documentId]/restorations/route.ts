import { cookies } from "next/headers";

import { SESSION_COOKIE_NAME } from "@/modules/identity/server";
import { IdentityRuntimeUnavailable, getIdentityRuntime } from "@/modules/identity/server";
import { IdentityServiceError } from "@/modules/identity/server";
import { createApiError, handleApiRequest } from "@/modules/shared/public";
import {
  DocumentVersionError,
  type RestoreDocumentCommand,
} from "@/modules/documents/server";
import {
  DocumentVersionRuntimeUnavailable,
  getDocumentVersionRuntime,
} from "@/modules/documents/server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { readonly params: Promise<{ readonly caseId: string; readonly documentId: string }> },
): Promise<Response> {
  return handleApiRequest(request, async (requestContext) => {
    const { caseId, documentId } = await context.params;
    if (!UUID.test(caseId) || !UUID.test(documentId)) throw createApiError("INVALID_REQUEST");
    const command = await parseCommand(request, requestContext.requestId);
    const cookieSecret = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
    if (!cookieSecret) throw createApiError("UNAUTHENTICATED");

    try {
      const actor = await getIdentityRuntime().service.requireSession({
        cookieSecret,
        sensitiveAction: true,
      });
      const result = await getDocumentVersionRuntime().service.restoreDocument({
        actor,
        caseId,
        documentId,
        command,
      });
      return toResponse(result);
    } catch (error) {
      throw mapDocumentVersionError(error);
    }
  });
}

async function parseCommand(request: Request, requestId: string): Promise<RestoreDocumentCommand> {
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
  if (
    !isRecord(body) ||
    typeof body.version_id !== "string" ||
    typeof body.expected_record_version !== "number"
  ) {
    throw createApiError("VALIDATION_FAILED");
  }
  return {
    versionId: body.version_id,
    expectedRecordVersion: body.expected_record_version,
    requestId,
    idempotencyKey,
  };
}

function toResponse(result: {
  readonly documentId: string;
  readonly activeVersionId: string | null;
  readonly lifecycleState: string;
  readonly recordVersion: number;
}) {
  return {
    document_id: result.documentId,
    active_version_id: result.activeVersionId,
    lifecycle_state: result.lifecycleState,
    record_version: result.recordVersion,
  };
}

function mapDocumentVersionError(error: unknown) {
  if (error instanceof IdentityRuntimeUnavailable || error instanceof DocumentVersionRuntimeUnavailable) {
    return createApiError("SERVICE_UNAVAILABLE");
  }
  if (error instanceof IdentityServiceError) return createApiError("UNAUTHENTICATED");
  if (!(error instanceof DocumentVersionError)) return createApiError("SERVICE_UNAVAILABLE");

  switch (error.code) {
    case "DOCUMENT_VERSION_COMMAND_INVALID":
      return createApiError("VALIDATION_FAILED");
    case "DOCUMENT_VERSION_CASE_FORBIDDEN":
    case "DOCUMENT_VERSION_NOT_FOUND":
      return createApiError("NOT_FOUND");
    case "DOCUMENT_VERSION_STALE":
      return createApiError("STALE_VERSION");
    case "DOCUMENT_VERSION_CLEAN_VERSION_REQUIRED":
    case "DOCUMENT_VERSION_DELETE_LEGAL_HOLD":
    case "DOCUMENT_VERSION_DELETE_NOT_ACTIVE":
    case "DOCUMENT_VERSION_RESTORE_NOT_PENDING_DELETE":
    case "DOCUMENT_VERSION_RESTORE_WINDOW_EXPIRED":
    case "DOCUMENT_VERSION_IDEMPOTENCY_KEY_REUSED":
    case "DOCUMENT_VERSION_IDEMPOTENCY_IN_PROGRESS":
      return createApiError("CONFLICT");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
