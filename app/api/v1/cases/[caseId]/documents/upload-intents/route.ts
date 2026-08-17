import { cookies } from "next/headers";

import { SESSION_COOKIE_NAME } from "@/modules/identity/server";
import {
  DocumentUploadError,
  type CreateDocumentUploadIntentCommand,
} from "@/modules/documents/server";
import {
  DocumentUploadRuntimeUnavailable,
  getDocumentUploadRuntime,
} from "@/modules/documents/server";
import { IdentityRuntimeUnavailable, getIdentityRuntime } from "@/modules/identity/server";
import { IdentityServiceError } from "@/modules/identity/server";
import {
  ApiContractError,
  createApiError,
  handleApiRequest,
} from "@/modules/shared/public";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  readonly params: Promise<{ readonly caseId: string }>;
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  return handleApiRequest(request, async (requestContext) => {
    try {
      const { caseId } = await context.params;
      if (!UUID.test(caseId)) throw createApiError("INVALID_REQUEST");
      const command = await parseCommand(request, requestContext.requestId);
      const cookieSecret = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
      if (!cookieSecret) throw createApiError("UNAUTHENTICATED");

      const actor = await getIdentityRuntime().service.requireSession({
        cookieSecret,
        sensitiveAction: true,
      });
      const result = await getDocumentUploadRuntime().uploadService.createCaseUploadIntent({
        actor,
        caseId,
        command,
      });
      return {
        document_id: result.documentId,
        document_version_id: result.documentVersionId,
        state: result.state,
        expires_at_ms: result.expiresAtMs,
        upload: {
          method: result.upload.method,
          url: result.upload.url,
          headers: result.upload.headers,
        },
      };
    } catch (error) {
      throw mapDocumentUploadError(error);
    }
  });
}

async function parseCommand(
  request: Request,
  requestId: string,
): Promise<CreateDocumentUploadIntentCommand> {
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

  const documentId = body.document_id;
  const checksumSha256 = body.checksum_sha256;
  const sizeBytes = body.size_bytes;
  const contentType = body.content_type;
  if (
    typeof documentId !== "string" ||
    typeof checksumSha256 !== "string" ||
    typeof sizeBytes !== "number" ||
    typeof contentType !== "string"
  ) {
    throw createApiError("VALIDATION_FAILED");
  }

  return {
    documentId,
    checksumSha256,
    sizeBytes,
    contentType,
    requestId,
    idempotencyKey,
  };
}

function mapDocumentUploadError(error: unknown): ApiContractError {
  if (error instanceof ApiContractError) return error;
  if (
    error instanceof IdentityRuntimeUnavailable ||
    error instanceof DocumentUploadRuntimeUnavailable
  ) {
    return createApiError("SERVICE_UNAVAILABLE");
  }
  if (error instanceof IdentityServiceError || error instanceof DocumentUploadError && error.code === "DOCUMENT_UPLOAD_SESSION_INVALID") {
    return createApiError("UNAUTHENTICATED");
  }
  if (!(error instanceof DocumentUploadError)) return createApiError("SERVICE_UNAVAILABLE");

  switch (error.code) {
    case "DOCUMENT_UPLOAD_INVALID":
      return createApiError("VALIDATION_FAILED");
    case "DOCUMENT_UPLOAD_CASE_NOT_FOUND":
    case "DOCUMENT_UPLOAD_DOCUMENT_NOT_FOUND":
    case "DOCUMENT_UPLOAD_CASE_FORBIDDEN":
      return createApiError("NOT_FOUND");
    case "DOCUMENT_UPLOAD_DOCUMENT_NOT_ACTIVE":
    case "DOCUMENT_UPLOAD_IDEMPOTENCY_IN_PROGRESS":
    case "DOCUMENT_UPLOAD_IDEMPOTENCY_KEY_REUSED":
    case "DOCUMENT_UPLOAD_INTENT_EXPIRED":
    case "DOCUMENT_UPLOAD_INTENT_MISMATCH":
      return createApiError("CONFLICT");
    case "DOCUMENT_UPLOAD_SESSION_INVALID":
      return createApiError("UNAUTHENTICATED");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
