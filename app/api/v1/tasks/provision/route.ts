import { requireApiRequestAccessContext } from "@/app/api/v1/request-access";
import { getTaskWorkflowRuntime, P3TaskError } from "@/modules/tasks/server";
import { createApiError, handleApiRequest } from "@/modules/shared/public";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FIELDS = ["assignment_id","brief","case_id","due_at","kind","source_event_id","target_id","task_key","title"];

export async function POST(request: Request): Promise<Response> {
  return handleApiRequest(request, async (context) => {
    try {
      if (request.headers.get("content-type")?.split(";",1)[0] !== "application/json") throw createApiError("INVALID_REQUEST");
      const body = await request.json() as Record<string, unknown>;
      if (!body || Array.isArray(body) || Object.keys(body).sort().join(",") !== FIELDS.slice().sort().join(",")) throw createApiError("INVALID_REQUEST");
      const strings = ["assignment_id","brief","case_id","due_at","kind","source_event_id","target_id","task_key","title"];
      if (strings.some((key) => typeof body[key] !== "string") || !["application_prepare_submit","interview_support"].includes(body.kind as string) ||
          !UUID.test(body.case_id as string) || !UUID.test(body.target_id as string) || !UUID.test(body.assignment_id as string) ||
          !UUID.test(body.source_event_id as string)) throw createApiError("VALIDATION_FAILED");
      const key = request.headers.get("idempotency-key")?.trim(); if (!key) throw createApiError("INVALID_REQUEST");
      const actor = await requireApiRequestAccessContext();
      const result = await getTaskWorkflowRuntime().p3Service.ensureTargetTask({
        actor, kind: body.kind as "application_prepare_submit" | "interview_support", caseId: body.case_id as string,
        targetId: body.target_id as string, assignmentId: body.assignment_id as string, sourceEventId: body.source_event_id as string,
        dueAt: body.due_at as string, title: body.title as string,
        brief: body.brief as string, taskKey: body.task_key as string, requestId: context.requestId, idempotencyKey: key,
      });
      return { id: result.id, record_version: result.recordVersion, state: result.state };
    } catch (error) { throw mapP3Error(error); }
  });
}
function mapP3Error(error: unknown) {
  if (!(error instanceof P3TaskError)) return error;
  switch (error.code) {
    case "INVALID": case "COMPLETION_INVALID": return createApiError("VALIDATION_FAILED");
    case "FORBIDDEN": return createApiError("FORBIDDEN"); case "NOT_FOUND": return createApiError("NOT_FOUND");
    case "STALE_VERSION": return createApiError("STALE_VERSION"); case "CONFLICT": return createApiError("CONFLICT");
    default: return createApiError("SERVICE_UNAVAILABLE");
  }
}
