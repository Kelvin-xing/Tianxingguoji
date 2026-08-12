import { cookies } from "next/headers";

import { SESSION_COOKIE_NAME } from "@/lib/auth/cookies";
import { IdentityRuntimeUnavailable, getIdentityRuntime } from "@/modules/identity/runtime";
import { IdentityServiceError } from "@/modules/identity/service";
import { createApiError, handleApiRequest } from "@/modules/shared/api-contract";
import {
  TaskWorkflowError,
  type TransitionTaskCommand,
} from "@/modules/tasks/service";
import {
  TaskWorkflowRuntimeUnavailable,
  getTaskWorkflowRuntime,
} from "@/modules/tasks/runtime";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { readonly params: Promise<{ readonly taskId: string }> },
): Promise<Response> {
  return handleApiRequest(request, async (requestContext) => {
    const { taskId } = await context.params;
    if (!UUID.test(taskId)) throw createApiError("INVALID_REQUEST");
    const command = await parseTransitionCommand(request, requestContext.requestId);
    const cookieSecret = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
    if (!cookieSecret) throw createApiError("UNAUTHENTICATED");

    try {
      const identity = getIdentityRuntime();
      const actor = await identity.service.requireSession({
        cookieSecret,
        sensitiveAction: true,
      });
      const result = await getTaskWorkflowRuntime().service.transitionTask({
        actor,
        taskId,
        command,
      });
      return {
        task_id: result.taskId,
        state: result.state,
        record_version: result.recordVersion,
      };
    } catch (error) {
      throw mapTaskWorkflowError(error);
    }
  });
}

async function parseTransitionCommand(
  request: Request,
  requestId: string,
): Promise<TransitionTaskCommand> {
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

  const to = body.to;
  const expectedRecordVersion = body.expected_record_version;
  const reason = body.reason;
  const nextAssigneeUserId = body.next_assignee_user_id ?? null;
  if (
    typeof to !== "string" ||
    typeof expectedRecordVersion !== "number" ||
    typeof reason !== "string" ||
    (nextAssigneeUserId !== null && typeof nextAssigneeUserId !== "string")
  ) {
    throw createApiError("INVALID_REQUEST");
  }

  return {
    to: to as TransitionTaskCommand["to"],
    expectedRecordVersion,
    reason,
    nextAssigneeUserId,
    requestId,
    idempotencyKey,
  };
}

function mapTaskWorkflowError(error: unknown) {
  if (
    error instanceof IdentityRuntimeUnavailable ||
    error instanceof TaskWorkflowRuntimeUnavailable
  ) {
    return createApiError("SERVICE_UNAVAILABLE");
  }
  if (error instanceof IdentityServiceError) return createApiError("UNAUTHENTICATED");
  if (!(error instanceof TaskWorkflowError)) return createApiError("SERVICE_UNAVAILABLE");

  switch (error.code) {
    case "TASK_COMMAND_INVALID":
    case "TASK_ASSIGNMENT_TARGET_REQUIRED":
    case "TASK_ASSIGNMENT_TARGET_INVALID":
    case "TASK_REASON_REQUIRED":
      return createApiError("VALIDATION_FAILED");
    case "TASK_NOT_FOUND":
      return createApiError("NOT_FOUND");
    case "TASK_PRIMARY_ADVISOR_REQUIRED":
    case "TASK_ACTOR_NOT_ALLOWED":
    case "TASK_APPROVAL_SEPARATION_REQUIRED":
      return createApiError("FORBIDDEN");
    case "TASK_TRANSITION_STALE_VERSION":
      return createApiError("STALE_VERSION");
    case "TASK_TRANSITION_NOT_ALLOWED":
    case "TASK_IDEMPOTENCY_KEY_REUSED":
    case "TASK_IDEMPOTENCY_IN_PROGRESS":
      return createApiError("CONFLICT");
    case "TASK_POLICY_NOT_APPROVED":
    case "TASK_POLICY_MATRIX_MISMATCH":
      return createApiError("SERVICE_UNAVAILABLE");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
