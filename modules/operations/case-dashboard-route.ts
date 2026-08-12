import { createApiError, handleApiRequest } from "../shared/api-contract.ts";
import {
  CaseDashboardProjectionError,
  type CaseDashboardActor,
  type CaseDashboardProjectionService,
} from "./case-dashboard-projection.ts";
import { CaseDashboardRuntimeUnavailable } from "./case-dashboard-runtime.ts";

export interface CaseDashboardGetDependencies {
  readonly getSessionSecret: () => Promise<string | null>;
  readonly requireSession: (cookieSecret: string) => Promise<CaseDashboardActor>;
  readonly getDashboardService: () => CaseDashboardProjectionService;
}

export class CaseDashboardAuthenticationError extends Error {
  constructor() {
    super("Dashboard authentication was rejected.");
    this.name = "CaseDashboardAuthenticationError";
  }
}

export function createCaseDashboardGetHandler(dependencies: CaseDashboardGetDependencies) {
  return async function caseDashboardGet(request: Request): Promise<Response> {
    return handleApiRequest(request, async () => {
      const cookieSecret = await dependencies.getSessionSecret();
      if (!cookieSecret) throw createApiError("UNAUTHENTICATED");

      try {
        const actor = await dependencies.requireSession(cookieSecret);
        const result = await dependencies.getDashboardService().getDashboard({ actor });
        return JSON.parse(JSON.stringify(result));
      } catch (error) {
        if (error instanceof CaseDashboardAuthenticationError) {
          throw createApiError("UNAUTHENTICATED");
        }
        if (error instanceof CaseDashboardRuntimeUnavailable) {
          throw createApiError("SERVICE_UNAVAILABLE");
        }
        if (error instanceof CaseDashboardProjectionError) {
          if (error.code === "CASE_DASHBOARD_FORBIDDEN") throw createApiError("FORBIDDEN");
          if (error.code === "CASE_DASHBOARD_INVALID") throw createApiError("INVALID_REQUEST");
          throw createApiError("SERVICE_UNAVAILABLE");
        }
        throw createApiError("SERVICE_UNAVAILABLE");
      }
    });
  };
}
