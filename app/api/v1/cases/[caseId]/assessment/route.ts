import { cookies } from "next/headers";

import { SESSION_COOKIE_NAME } from "@/lib/auth/cookies";
import {
  AssessmentServiceError,
  type UpdateAssessmentAnswerCommand,
} from "@/modules/cases/assessment-service";
import { CaseRuntimeUnavailable, getCaseRuntime } from "@/modules/cases/runtime";
import { IdentityRuntimeUnavailable, getIdentityRuntime } from "@/modules/identity/runtime";
import { IdentityServiceError } from "@/modules/identity/service";
import {
  ApiContractError,
  createApiError,
  handleApiRequest,
} from "@/modules/shared/api-contract";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SEMANTIC_STATES = new Set([
  "provided",
  "unknown",
  "not_applicable",
  "declined_to_provide",
]);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  readonly params: Promise<{ readonly caseId: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  return handleApiRequest(request, async () => {
    try {
      const { caseId } = await context.params;
      assertCaseId(caseId);
      const actor = await requireActor();
      const view = await getCaseRuntime().assessmentService.getCaseAssessment({ actor, caseId });
      return {
        assessment_id: view.assessmentId,
        manifest_id: view.manifestId,
        status: view.status,
        schema: {
          manifest_id: view.schema.manifestId,
          composition_version: view.schema.compositionVersion,
          fields: view.schema.fields.map((field) => ({
            field_id: field.fieldId,
            ...(field.label ? { label: field.label } : {}),
            layer: field.layer,
            ...(field.moduleId ? { module_id: field.moduleId } : {}),
            ...(field.moduleVersion ? { module_version: field.moduleVersion } : {}),
            value_type: field.valueType,
            ...(field.enumValues ? { enum_values: [...field.enumValues] } : {}),
            visibility: field.visibility,
            blocking_stages: [...field.blockingStages],
          })),
        },
        answers: view.answers.map((answer) => ({
          field_id: answer.fieldId,
          semantic_state: answer.semanticState,
          value: answer.value,
          value_type: answer.valueType,
          record_version: answer.recordVersion,
        })),
      };
    } catch (error) {
      throw mapAssessmentError(error);
    }
  });
}

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  return handleApiRequest(request, async (requestContext) => {
    try {
      const { caseId } = await context.params;
      assertCaseId(caseId);
      const command = await parseUpdateCommand(request, requestContext.requestId);
      const actor = await requireActor();
      const result = await getCaseRuntime().assessmentService.updateAssessmentAnswer({
        actor,
        caseId,
        command,
      });
      return {
        assessment_id: result.assessmentId,
        field_id: result.fieldId,
        semantic_state: result.semanticState,
        value: result.value,
        value_type: result.valueType,
        record_version: result.recordVersion,
      };
    } catch (error) {
      throw mapAssessmentError(error);
    }
  });
}

async function requireActor() {
  const cookieSecret = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  if (!cookieSecret) throw createApiError("UNAUTHENTICATED");
  const identity = getIdentityRuntime();
  return identity.service.requireSession({ cookieSecret, sensitiveAction: false });
}

async function parseUpdateCommand(
  request: Request,
  requestId: string,
): Promise<UpdateAssessmentAnswerCommand> {
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

  const fieldId = body.field_id;
  const semanticState = body.semantic_state;
  const value = body.value;
  const valueType = body.value_type;
  const expectedRecordVersion = body.expected_record_version;
  if (
    typeof fieldId !== "string" ||
    typeof semanticState !== "string" ||
    !SEMANTIC_STATES.has(semanticState) ||
    (valueType !== null && typeof valueType !== "string") ||
    typeof expectedRecordVersion !== "number"
  ) {
    throw createApiError("VALIDATION_FAILED");
  }

  return {
    fieldId,
    semanticState: semanticState as UpdateAssessmentAnswerCommand["semanticState"],
    value,
    valueType,
    expectedRecordVersion,
    requestId,
    idempotencyKey,
  };
}

function assertCaseId(caseId: string): void {
  if (!UUID.test(caseId)) throw createApiError("INVALID_REQUEST");
}

function mapAssessmentError(error: unknown): ApiContractError {
  if (error instanceof ApiContractError) return error;
  if (error instanceof IdentityRuntimeUnavailable || error instanceof CaseRuntimeUnavailable) {
    return createApiError("SERVICE_UNAVAILABLE");
  }
  if (error instanceof IdentityServiceError) return createApiError("UNAUTHENTICATED");
  if (!(error instanceof AssessmentServiceError)) return createApiError("SERVICE_UNAVAILABLE");

  switch (error.code) {
    case "ASSESSMENT_ANSWER_INVALID":
      return createApiError("VALIDATION_FAILED");
    case "ASSESSMENT_ANSWER_STALE_VERSION":
      return createApiError("STALE_VERSION", {
        details: {
          current_version: error.currentRecordVersion ?? 0,
          ...(error.diffToken ? { diff_token: error.diffToken } : {}),
        },
      });
    case "ASSESSMENT_ANSWER_IDEMPOTENCY_KEY_REUSED":
    case "ASSESSMENT_ANSWER_IDEMPOTENCY_IN_PROGRESS":
      return createApiError("CONFLICT");
    case "ASSESSMENT_CASE_NOT_FOUND":
      return createApiError("NOT_FOUND");
    case "ASSESSMENT_READ_FORBIDDEN":
    case "ASSESSMENT_WRITE_FORBIDDEN":
      return createApiError("FORBIDDEN");
    case "ASSESSMENT_SCHEMA_INVALID":
      return createApiError("SERVICE_UNAVAILABLE");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
