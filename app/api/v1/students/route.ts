import {
  getStudentCreateRuntime,
  getStudentReadRuntime,
  GuardianRelationshipRuntimeUnavailable,
  StudentCreateRuntimeUnavailable,
  isStudentCreateError,
} from "@/modules/crm/server";
import { requireIdentityActor } from "@/modules/identity/web";
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
      const actor = await requireIdentityActor();
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
    const actor = await requireIdentityActor();
    const created = await getStudentCreateRuntime().service.create({ actor, command });
    return successResponse(context, {
      student: {
        id: created.student.id,
        display_name: created.student.displayName,
      },
      primary_guardian: {
        id: created.primaryGuardian.id,
        display_name: created.primaryGuardian.displayName,
      },
      relationship: {
        id: created.relationship.id,
        relationship_type: created.relationship.relationshipType,
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
    case "STUDENT_CREATE_FORBIDDEN": return createApiError("FORBIDDEN");
    case "STUDENT_CREATE_INVALID": return createApiError("VALIDATION_FAILED");
    case "STUDENT_CREATE_IDEMPOTENCY_CONFLICT":
    case "STUDENT_CREATE_IDEMPOTENCY_IN_PROGRESS": return createApiError("CONFLICT");
    case "STUDENT_CREATE_UNAVAILABLE": return createApiError("SERVICE_UNAVAILABLE");
  }
}
