import { cookies } from "next/headers";

import { SESSION_COOKIE_NAME } from "@/modules/identity/server";
import {
  CaseOutcomeError,
  type CaseOutcomeDraft,
  type SchoolTargetTransitionCommand,
} from "@/modules/cases/server";
import {
  CaseOutcomeRuntimeUnavailable,
  getCaseOutcomeRuntime,
} from "@/modules/cases/server";
import type { SchoolTargetEvidence } from "@/modules/cases/public";
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
      const command = await parseTargetTransitionCommand(request, requestContext.requestId);
      const cookieSecret = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
      if (!cookieSecret) throw createApiError("UNAUTHENTICATED");
      const actor = await getIdentityRuntime().service.requireSession({
        cookieSecret,
        sensitiveAction: true,
      });
      const result = await getCaseOutcomeRuntime().service.transitionSchoolTarget({
        actor,
        caseId,
        targetId,
        command,
      });
      return {
        target_id: result.targetId,
        case_id: result.caseId,
        state: result.state,
        record_version: result.recordVersion,
        outcome: result.outcome === null
          ? null
          : {
              outcome_revision_id: result.outcome.outcomeRevisionId,
              code: result.outcome.code,
              record_version: result.outcome.recordVersion,
            },
      };
    } catch (error) {
      throw mapCaseOutcomeError(error);
    }
  });
}

async function parseTargetTransitionCommand(
  request: Request,
  requestId: string,
): Promise<SchoolTargetTransitionCommand> {
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
    throw createApiError("INVALID_REQUEST");
  }
  const body = await parseObjectBody(request);
  const toState = body.to_state;
  const expectedRecordVersion = body.expected_record_version;
  const evidence = parseEvidence(body.evidence);
  const outcome = parseOutcome(body.outcome);
  if (typeof toState !== "string" || typeof expectedRecordVersion !== "number" || evidence === null) {
    throw createApiError("VALIDATION_FAILED");
  }
  return { toState: toState as SchoolTargetTransitionCommand["toState"], expectedRecordVersion, evidence, outcome, requestId, idempotencyKey };
}

async function parseObjectBody(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw createApiError("INVALID_REQUEST");
  }
  if (!isRecord(body)) throw createApiError("INVALID_REQUEST");
  return body;
}

function parseEvidence(value: unknown): SchoolTargetEvidence | null {
  if (!isRecord(value)) return null;
  const dueDate = nullableString(value.due_date);
  const checklistCompleteReceipt = nullableString(value.checklist_complete_receipt);
  const officialSubmissionReference = nullableString(value.official_submission_reference);
  const invitationEvidence = nullableString(value.invitation_evidence);
  const interviewAt = nullableString(value.interview_at);
  if (
    dueDate === undefined ||
    checklistCompleteReceipt === undefined ||
    officialSubmissionReference === undefined ||
    invitationEvidence === undefined ||
    interviewAt === undefined
  ) {
    return null;
  }
  return { dueDate, checklistCompleteReceipt, officialSubmissionReference, invitationEvidence, interviewAt };
}

function parseOutcome(value: unknown): CaseOutcomeDraft | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) return null;
  if (
    typeof value.code !== "string" ||
    typeof value.occurred_on !== "string" ||
    typeof value.evidence_source !== "string" ||
    typeof value.source_reference !== "string"
  ) {
    return null;
  }
  return {
    code: value.code as CaseOutcomeDraft["code"],
    occurredOn: value.occurred_on,
    evidenceSource: value.evidence_source as CaseOutcomeDraft["evidenceSource"],
    sourceReference: value.source_reference,
  };
}

function nullableString(value: unknown): string | null | undefined {
  return value === null || typeof value === "string" ? value : undefined;
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
