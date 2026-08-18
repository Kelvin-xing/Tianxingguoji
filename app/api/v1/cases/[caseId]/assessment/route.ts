import {
  getCaseWorkspaceRuntime,
  type UpdateAssessmentAnswerCommand,
} from "@/modules/cases/server";
import { requireIdentityActor } from "@/modules/identity/web";
import {
  createApiError,
  handleApiRequest,
} from "@/modules/shared/public";
import {
  assertAssessmentCaseId,
  mapAssessmentError,
  requireAssessmentIdempotencyKey,
} from "./route-support";

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
      assertAssessmentCaseId(caseId);
      const actor = await requireIdentityActor();
      const view = await getCaseWorkspaceRuntime().assessmentService.getCaseAssessment({ actor, caseId });
      return {
        assessment_id: view.assessmentId,
        manifest_id: view.manifestId,
        record_version: view.recordVersion,
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
      assertAssessmentCaseId(caseId);
      const command = await parseUpdateCommand(request, requestContext.requestId);
      const actor = await requireIdentityActor();
      const result = await getCaseWorkspaceRuntime().assessmentService.updateAssessmentAnswer({
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

async function parseUpdateCommand(
  request: Request,
  requestId: string,
): Promise<UpdateAssessmentAnswerCommand> {
  const idempotencyKey = requireAssessmentIdempotencyKey(request);

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
