import { requireApiRequestAccessContext } from "@/app/api/v1/request-access";
import { getTaskWorkflowRuntime, P3TaskError, type P3TaskAction } from "@/modules/tasks/server";
import { createApiError, handleApiRequest } from "@/modules/shared/public";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIONS = ["accept","reject","reassign","cancel","complete"] as const;

export async function POST(request: Request, context: { readonly params: Promise<{ readonly taskId: string }> }): Promise<Response> {
  return handleApiRequest(request, async (requestContext) => {
    try {
      if (request.headers.get("content-type")?.split(";", 1)[0] !== "application/json") throw createApiError("INVALID_REQUEST");
      const { taskId } = await context.params; if (!UUID.test(taskId)) throw createApiError("INVALID_REQUEST");
      const body = parseBody(await request.json());
      const key = request.headers.get("idempotency-key")?.trim(); if (!key) throw createApiError("INVALID_REQUEST");
      const actor = await requireApiRequestAccessContext();
      const result = await getTaskWorkflowRuntime().p3Service.transitionTargetTask({
        actor, taskId, action: body.action, expectedRecordVersion: body.expected_record_version,
        reason: body.reason ?? "", nextAssigneeUserId: body.next_assignee_user_id ?? null,
        completionRecord: body.completion_record ?? null, evidenceReference: body.evidence_reference ?? null,
        requestId: requestContext.requestId, idempotencyKey: key,
      });
      return { id: result.id, record_version: result.recordVersion, state: result.state, completion_receipt_id: result.completionReceiptId ?? null };
    } catch (error) { throw mapP3Error(error); }
  });
}
function mapP3Error(error: unknown) {
  if (!(error instanceof P3TaskError)) return error;
  switch (error.code) {
    case "INVALID": case "COMPLETION_INVALID": return createApiError("VALIDATION_FAILED"); case "FORBIDDEN": return createApiError("FORBIDDEN");
    case "NOT_FOUND": return createApiError("NOT_FOUND"); case "STALE_VERSION": return createApiError("STALE_VERSION");
    case "CONFLICT": return createApiError("CONFLICT"); default: return createApiError("SERVICE_UNAVAILABLE");
  }
}

type TransitionBody = Readonly<{
  action: P3TaskAction; expected_record_version: number; reason?: string;
  next_assignee_user_id?: string; completion_record?: Record<string, unknown>;
  evidence_reference?: string | null;
}>;

function parseBody(value: unknown): TransitionBody {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw createApiError("VALIDATION_FAILED");
  const body = value as Record<string, unknown>;
  if (typeof body.action !== "string" || !ACTIONS.includes(body.action as typeof ACTIONS[number]) ||
      typeof body.expected_record_version !== "number" || !Number.isSafeInteger(body.expected_record_version)) {
    throw createApiError("VALIDATION_FAILED");
  }
  const action = body.action as P3TaskAction;
  const keys = Object.keys(body).sort();
  const expected = action === "accept" ? ["action","expected_record_version"]
    : action === "reject" || action === "cancel" ? ["action","expected_record_version","reason"]
    : action === "reassign" ? ["action","expected_record_version","next_assignee_user_id","reason"]
    : ["action","completion_record","evidence_reference","expected_record_version"];
  if (keys.join(",") !== expected.slice().sort().join(",")) throw createApiError("VALIDATION_FAILED");
  if ((action === "reject" || action === "cancel" || action === "reassign") && typeof body.reason !== "string") throw createApiError("VALIDATION_FAILED");
  if (action === "reassign" && (typeof body.next_assignee_user_id !== "string" || !UUID.test(body.next_assignee_user_id))) throw createApiError("VALIDATION_FAILED");
  if (action === "complete") {
    if (!body.completion_record || typeof body.completion_record !== "object" || Array.isArray(body.completion_record) ||
        (body.evidence_reference !== null && typeof body.evidence_reference !== "string")) throw createApiError("VALIDATION_FAILED");
    const completionKeys = Object.keys(body.completion_record as Record<string, unknown>).sort().join(",");
    if (!["checklist_snapshot,official_submission_reference,no_reference_declared,submission_channel,submitted_at,submitter_user_id",
      "coaching_summary,completed_at,interview_method"].includes(completionKeys)) throw createApiError("VALIDATION_FAILED");
  }
  return body as TransitionBody;
}
