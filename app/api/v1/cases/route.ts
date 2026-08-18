import { getCaseWorkspaceRuntime, CaseRuntimeUnavailable, CaseWorkspaceError } from "@/modules/cases/server";
import { requireIdentityActor } from "@/modules/identity/web";
import { createApiError, handleApiRequest, type JsonValue } from "@/modules/shared/public";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handleApiRequest(request, async () => {
    try {
      const actor = await requireIdentityActor();
      const cases = await getCaseWorkspaceRuntime().service.listCases(actor);
      return { cases: cases.map((record) => ({ ...record })) } satisfies JsonValue;
    } catch (error) {
      throw mapError(error);
    }
  });
}

export async function POST(request: Request): Promise<Response> {
  return handleApiRequest(request, async (context) => {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw createApiError("INVALID_REQUEST");
    }
    if (!isRecord(body)) throw createApiError("INVALID_REQUEST");
    const idempotencyKey = request.headers.get("idempotency-key")?.trim();
    if (!idempotencyKey) throw createApiError("INVALID_REQUEST");
    if (
      typeof body.student_id !== "string" ||
      typeof body.intake_year !== "number" ||
      typeof body.admission_type !== "string" ||
      typeof body.primary_role_binding_id !== "string" ||
      typeof body.manifest_id !== "string"
    ) {
      throw createApiError("VALIDATION_FAILED");
    }
    const command = {
      studentId: body.student_id,
      intakeYear: body.intake_year,
      admissionType: body.admission_type,
      primaryRoleBindingId: body.primary_role_binding_id,
      manifestId: body.manifest_id,
      requestId: context.requestId,
      idempotencyKey,
    };
    try {
      const actor = await requireIdentityActor();
      const created = await getCaseWorkspaceRuntime().service.createCase({ actor, command });
      return { case: { ...created } } satisfies JsonValue;
    } catch (error) {
      throw mapError(error);
    }
  });
}

function mapError(error: unknown) {
  if (error instanceof CaseRuntimeUnavailable) return createApiError("SERVICE_UNAVAILABLE");
  if (!(error instanceof CaseWorkspaceError)) return error;
  switch (error.code) {
    case "CASE_WORKSPACE_FORBIDDEN": return createApiError("FORBIDDEN");
    case "CASE_WORKSPACE_STUDENT_NOT_FOUND": return createApiError("NOT_FOUND");
    case "CASE_WORKSPACE_DUPLICATE":
    case "CASE_WORKSPACE_IDEMPOTENCY_CONFLICT":
    case "CASE_WORKSPACE_IDEMPOTENCY_IN_PROGRESS": return createApiError("CONFLICT");
    case "CASE_WORKSPACE_BINDING_INACTIVE":
    case "CASE_WORKSPACE_MANIFEST_NOT_APPROVED":
    case "CASE_WORKSPACE_INVALID": return createApiError("VALIDATION_FAILED");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
