import { isLocalSyntheticMode } from "../../../../../lib/runtime/local-synthetic-config.ts";
import type { LocalSyntheticReadinessReport } from "../../../../../lib/runtime/local-synthetic-readiness.ts";
import {
  createApiError,
  handleApiRequest,
} from "../../../../../modules/shared/public.ts";

type Environment = Readonly<Record<string, string | undefined>>;
type ReadinessCheck = (environment: Environment) => Promise<LocalSyntheticReadinessReport>;

export function handleLocalReadinessRequest(
  request: Request,
  dependencies: Readonly<{
    environment: Environment;
    checkReadiness: ReadinessCheck;
  }>,
): Promise<Response> {
  return handleApiRequest(request, async () => {
    if (!isLocalSyntheticMode(dependencies.environment)) {
      throw createApiError("NOT_FOUND");
    }

    const report = await dependencies.checkReadiness(dependencies.environment);
    const dependencyStates = {
      postgresql: report.dependencies.postgresql,
      postgresql_identity: report.dependencies.postgresql_identity,
      postgresql_application: report.dependencies.postgresql_application,
      localstack_s3: report.dependencies.localstack_s3,
      localstack_sqs: report.dependencies.localstack_sqs,
      clamav: report.dependencies.clamav,
    } as const;
    if (report.status !== "ready") {
      throw createApiError("SERVICE_UNAVAILABLE", {
        details: { dependencies: dependencyStates },
      });
    }

    return {
      mode: report.mode,
      status: report.status,
      dependencies: dependencyStates,
    };
  });
}
