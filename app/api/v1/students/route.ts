import {
  getStudentCreateRuntime,
  getStudentReadRuntime,
  GuardianRelationshipRuntimeUnavailable,
  StudentCreateRuntimeUnavailable,
  isStudentCreateError,
} from "@/modules/crm/server";
import { requireApiRequestAccessContext } from "@/app/api/v1/request-access";
import {
  createApiError,
  createRequestContext,
  errorResponse,
  handleApiRequest,
  successResponse,
  type JsonValue,
} from "@/modules/shared/public";

import { parseStudentCreateRequest } from "./route-contract.ts";
import { mapStudentReadError } from "../student-read-handler.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handleApiRequest(request, async () => {
    try {
      const actor = await requireApiRequestAccessContext();
      const students = await getStudentReadRuntime().service.listStudents(actor);
      return { students: students.map((student) => ({ ...student })) } satisfies JsonValue;
    } catch (error) {
      if (error instanceof GuardianRelationshipRuntimeUnavailable) {
        throw createApiError("SERVICE_UNAVAILABLE");
      }
      throw mapStudentReadError(error, "list");
    }
  });
}

export async function POST(request: Request): Promise<Response> {
  const context = createRequestContext(request);
  try {
    const command = await parseStudentCreateRequest(request, context.requestId);
    const actor = await requireApiRequestAccessContext();
    const created = await getStudentCreateRuntime().service.create({ actor, command });
    return successResponse(context, {
      student: {
        id: created.student.id,
        record_version: created.student.recordVersion,
      },
      primary_guardian: {
        id: created.primaryGuardian.id,
        record_version: created.primaryGuardian.recordVersion,
      },
      relationship: {
        id: created.relationship.id,
        record_version: created.relationship.recordVersion,
      },
    }, 201);
  } catch (error) {
    return errorResponse(context, mapCreateError(error));
  }
}

function mapCreateError(error: unknown): unknown {
  if (error instanceof StudentCreateRuntimeUnavailable ||
      error instanceof GuardianRelationshipRuntimeUnavailable) {
    return createApiError("SERVICE_UNAVAILABLE");
  }
  if (!isStudentCreateError(error)) return error;
  switch (error.code) {
    case "STUDENT_CREATE_DUPLICATE_WARNING_REQUIRED": return createApiError("CONFLICT", { details: { code: "DUPLICATE_WARNING_REQUIRED" } });
    case "STUDENT_CREATE_FORBIDDEN": return createApiError("FORBIDDEN");
    case "STUDENT_CREATE_INVALID": return createApiError("VALIDATION_FAILED");
    case "STUDENT_CREATE_IDEMPOTENCY_CONFLICT":
    case "STUDENT_CREATE_IDEMPOTENCY_IN_PROGRESS": return createApiError("CONFLICT");
    case "STUDENT_CREATE_UNAVAILABLE": return createApiError("SERVICE_UNAVAILABLE");
  }
}
