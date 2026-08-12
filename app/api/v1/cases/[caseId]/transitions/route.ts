import { cookies } from "next/headers";

import { SESSION_COOKIE_NAME } from "@/lib/auth/cookies";
import {
  CaseTransitionError,
  type TransitionServiceCaseCommand,
} from "@/modules/cases/transition-service";
import {
  CaseTransitionRuntimeUnavailable,
  getCaseTransitionRuntime,
} from "@/modules/cases/transition-runtime";
import { IdentityRuntimeUnavailable, getIdentityRuntime } from "@/modules/identity/runtime";
import { IdentityServiceError } from "@/modules/identity/service";
import {
  ApiContractError,
  createApiError,
  handleApiRequest,
} from "@/modules/shared/api-contract";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { readonly params: Promise<{ readonly caseId: string }> },
): Promise<Response> {
  return handleApiRequest(request, async (requestContext) => {
    try {
      const { caseId } = await context.params;
      if (!UUID.test(caseId)) throw createApiError("INVALID_REQUEST");
      const command = await parseTransitionCommand(request, requestContext.requestId);
      const cookieSecret = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
      if (!cookieSecret) throw createApiError("UNAUTHENTICATED");
      const actor = await getIdentityRuntime().service.requireSession({
        cookieSecret,
        sensitiveAction: true,
      });
      const result = await getCaseTransitionRuntime().service.transitionServiceCase({
        actor,
        caseId,
        command,
      });
      return {
        case_id: result.caseId,
        stage: result.stage,
        record_version: result.recordVersion,
      };
    } catch (error) {
      throw mapCaseTransitionError(error);
    }
  });
}

async function parseTransitionCommand(
  request: Request,
  requestId: string,
): Promise<TransitionServiceCaseCommand> {
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

  const toStage = body.to_stage;
  const expectedRecordVersion = body.expected_record_version;
  const reason = body.reason;
  if (
    typeof toStage !== "string" ||
    typeof expectedRecordVersion !== "number" ||
    typeof reason !== "string"
  ) {
    throw createApiError("VALIDATION_FAILED");
  }

  return {
    toStage: toStage as TransitionServiceCaseCommand["toStage"],
    expectedRecordVersion,
    reason,
    requestId,
    idempotencyKey,
  };
}

function mapCaseTransitionError(error: unknown): ApiContractError {
  if (error instanceof ApiContractError) return error;
  if (
    error instanceof IdentityRuntimeUnavailable ||
    error instanceof CaseTransitionRuntimeUnavailable
  ) {
    return createApiError("SERVICE_UNAVAILABLE");
  }
  if (error instanceof IdentityServiceError) return createApiError("UNAUTHENTICATED");
  if (!(error instanceof CaseTransitionError)) return createApiError("SERVICE_UNAVAILABLE");

  switch (error.code) {
    case "CASE_TRANSITION_INVALID":
    case "CASE_TRANSITION_REASON_REQUIRED":
    case "CASE_TRANSITION_ASSESSMENT_INCOMPLETE":
      return createApiError("VALIDATION_FAILED");
    case "CASE_TRANSITION_NOT_ALLOWED":
    case "CASE_TRANSITION_IDEMPOTENCY_KEY_REUSED":
    case "CASE_TRANSITION_IDEMPOTENCY_IN_PROGRESS":
      return createApiError("CONFLICT");
    case "CASE_TRANSITION_ADVISOR_REQUIRED":
    case "CASE_TRANSITION_PRIMARY_ADVISOR_REQUIRED":
    case "CASE_TRANSITION_FOUNDER_REQUIRED":
    case "CASE_TRANSITION_CASE_FORBIDDEN":
      return createApiError("FORBIDDEN");
    case "CASE_TRANSITION_CASE_NOT_FOUND":
      return createApiError("NOT_FOUND");
    case "CASE_TRANSITION_STALE_VERSION":
      return createApiError("STALE_VERSION", {
        details: { current_version: error.currentRecordVersion ?? 0 },
      });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
