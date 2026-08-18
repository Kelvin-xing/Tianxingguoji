import {
  createApiError,
  handleApiRequest,
} from "../../../../../modules/shared/public.ts";
import { isLocalSyntheticMode } from "../../../../../lib/runtime/local-synthetic-config.ts";
import {
  checkLocalSyntheticReadiness,
  type LocalSyntheticReadinessReport,
} from "../../../../../lib/runtime/local-synthetic-readiness.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Environment = Readonly<Record<string, string | undefined>>;
type ReadinessCheck = (environment: Environment) => Promise<LocalSyntheticReadinessReport>;

export function GET(request: Request): Promise<Response> {
  return handleLocalReadinessRequest(request, {
    environment: process.env,
    checkReadiness: (environment) => checkLocalSyntheticReadiness({ environment }),
  });
}

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

function unsupportedMethod(request: Request): Promise<Response> {
  return handleApiRequest(request, () => {
    throw createApiError("METHOD_NOT_ALLOWED");
  }).then(withAllowedMethods);
}

function withAllowedMethods(response: Response): Response {
  response.headers.set("allow", "GET");
  return response;
}

export const POST = unsupportedMethod;
export const PUT = unsupportedMethod;
export const PATCH = unsupportedMethod;
export const DELETE = unsupportedMethod;
export const OPTIONS = unsupportedMethod;
