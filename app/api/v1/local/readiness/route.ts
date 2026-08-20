import {
  createApiError,
  handleApiRequest,
} from "../../../../../modules/shared/public.ts";
import { checkLocalSyntheticReadiness } from "../../../../../lib/runtime/local-synthetic-readiness.ts";
import { handleLocalReadinessRequest } from "./handler.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return handleLocalReadinessRequest(request, {
    environment: process.env,
    checkReadiness: (environment) => checkLocalSyntheticReadiness({ environment }),
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
