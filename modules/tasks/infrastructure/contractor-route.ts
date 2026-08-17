import type { IdentitySessionActor } from "../../identity/public.ts";
import { IdentityRuntimeUnavailable } from "../../identity/server.ts";
import { IdentityServiceError } from "../../identity/server.ts";
import { createApiError, handleApiRequest } from "../../shared/public.ts";
import {
  ContractorTaskWorkspaceError,
  type ContractorTaskWorkspaceService,
} from "../application/contractor-workspace.ts";
import { ContractorTaskWorkspaceRuntimeUnavailable } from "./contractor-workspace-runtime.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ContractorTaskGetDependencies {
  readonly getSessionSecret: () => Promise<string | null>;
  readonly requireSession: (cookieSecret: string) => Promise<IdentitySessionActor>;
  readonly getWorkspaceService: () => ContractorTaskWorkspaceService;
}

export type ContractorTaskGetContext = {
  readonly params: Promise<{ readonly taskId: string }>;
};

export function createContractorTaskGetHandler(dependencies: ContractorTaskGetDependencies) {
  return async function contractorTaskGet(
    request: Request,
    context: ContractorTaskGetContext,
  ): Promise<Response> {
    return handleApiRequest(request, async () => {
      const { taskId } = await context.params;
      if (!UUID.test(taskId)) throw createApiError("INVALID_REQUEST");

      const cookieSecret = await dependencies.getSessionSecret();
      if (!cookieSecret) throw createApiError("UNAUTHENTICATED");

      try {
        const actor = await dependencies.requireSession(cookieSecret);
        const result = await dependencies.getWorkspaceService().getAssignedTask({ actor, taskId });
        return {
          task_id: result.task_id,
          title: result.title,
          task_brief: result.task_brief,
          due_at: result.due_at,
          state: result.state,
          record_version: result.record_version,
        };
      } catch (error) {
        throw mapContractorTaskError(error);
      }
    });
  };
}

function mapContractorTaskError(error: unknown) {
  if (error instanceof IdentityServiceError) return createApiError("UNAUTHENTICATED");
  if (
    error instanceof IdentityRuntimeUnavailable ||
    error instanceof ContractorTaskWorkspaceRuntimeUnavailable
  ) {
    return createApiError("SERVICE_UNAVAILABLE");
  }
  if (!(error instanceof ContractorTaskWorkspaceError)) {
    return createApiError("SERVICE_UNAVAILABLE");
  }

  switch (error.code) {
    case "CONTRACTOR_TASK_INVALID":
      return createApiError("INVALID_REQUEST");
    case "CONTRACTOR_TASK_FORBIDDEN":
      return createApiError("FORBIDDEN");
    case "CONTRACTOR_TASK_NOT_FOUND":
      return createApiError("NOT_FOUND");
    case "CONTRACTOR_TASK_PROJECTION_INVALID":
      return createApiError("SERVICE_UNAVAILABLE");
  }
}
