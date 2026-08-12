import { cookies } from "next/headers";

import { SESSION_COOKIE_NAME } from "@/lib/auth/cookies";
import {
  CaseOutcomeError,
  type CaseOutcomeDraft,
  type CorrectCaseOutcomeCommand,
} from "@/modules/cases/outcome-service";
import {
  CaseOutcomeRuntimeUnavailable,
  getCaseOutcomeRuntime,
} from "@/modules/cases/outcome-runtime";
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
  context: {
    readonly params: Promise<{ readonly caseId: string; readonly targetId: string }>;
  },
): Promise<Response> {
  return handleApiRequest(request, async (requestContext) => {
    try {
      const { caseId, targetId } = await context.params;
      if (!UUID.test(caseId) || !UUID.test(targetId)) throw createApiError("INVALID_REQUEST");
      const command = await parseCorrectionCommand(request, requestContext.requestId);
      const cookieSecret = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
      if (!cookieSecret) throw createApiError("UNAUTHENTICATED");
      const actor = await getIdentityRuntime().service.requireSession({
        cookieSecret,
        sensitiveAction: true,
      });
      const result = await getCaseOutcomeRuntime().service.correctCaseOutcome({
        actor,
        caseId,
        targetId,
        command,
      });
      return {
        outcome_revision_id: result.outcomeRevisionId,
        target_id: result.targetId,
        code: result.code,
        record_version: result.recordVersion,
      };
    } catch (error) {
      throw mapCaseOutcomeError(error);
    }
  });
}

async function parseCorrectionCommand(
  request: Request,
  requestId: string,
): Promise<CorrectCaseOutcomeCommand> {
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
  if (!isRecord(body) || typeof body.expected_outcome_record_version !== "number") {
    throw createApiError("VALIDATION_FAILED");
  }
  const outcome = body.outcome;
  if (
    !isRecord(outcome) ||
    typeof outcome.code !== "string" ||
    typeof outcome.occurred_on !== "string" ||
    typeof outcome.evidence_source !== "string" ||
    typeof outcome.source_reference !== "string"
  ) {
    throw createApiError("VALIDATION_FAILED");
  }
  return {
    expectedOutcomeRecordVersion: body.expected_outcome_record_version,
    outcome: {
      code: outcome.code as CaseOutcomeDraft["code"],
      occurredOn: outcome.occurred_on,
      evidenceSource: outcome.evidence_source as CaseOutcomeDraft["evidenceSource"],
      sourceReference: outcome.source_reference,
    },
    requestId,
    idempotencyKey,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapCaseOutcomeError(error: unknown): ApiContractError {
  if (error instanceof ApiContractError) return error;
  if (error instanceof IdentityRuntimeUnavailable || error instanceof CaseOutcomeRuntimeUnavailable) {
    return createApiError("SERVICE_UNAVAILABLE");
  }
  if (error instanceof IdentityServiceError) return createApiError("UNAUTHENTICATED");
  if (!(error instanceof CaseOutcomeError)) return createApiError("SERVICE_UNAVAILABLE");
  switch (error.code) {
    case "CASE_OUTCOME_INVALID":
    case "CASE_OUTCOME_EVIDENCE_REQUIRED":
    case "CASE_OUTCOME_REQUIRED":
    case "CASE_OUTCOME_CODE_INVALID":
      return createApiError("VALIDATION_FAILED");
    case "CASE_OUTCOME_ADVISOR_REQUIRED":
    case "CASE_OUTCOME_CASE_FORBIDDEN":
      return createApiError("FORBIDDEN");
    case "CASE_OUTCOME_CASE_NOT_FOUND":
    case "CASE_OUTCOME_TARGET_NOT_FOUND":
      return createApiError("NOT_FOUND");
    case "CASE_OUTCOME_STALE_VERSION":
      return createApiError("STALE_VERSION");
    case "CASE_OUTCOME_ROUTE_POLICY_REQUIRED":
    case "CASE_OUTCOME_TRANSITION_NOT_ALLOWED":
    case "CASE_OUTCOME_IDEMPOTENCY_KEY_REUSED":
    case "CASE_OUTCOME_IDEMPOTENCY_IN_PROGRESS":
      return createApiError("CONFLICT");
  }
}
