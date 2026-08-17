import {
  createApiError,
  handleApiRequest,
} from "../../../../modules/shared/public.ts";

export function GET(request: Request): Promise<Response> {
  return handleApiRequest(request, () => ({ status: "ok" }));
}

export function POST(request: Request): Promise<Response> {
  return handleApiRequest(request, async () => {
    try {
      await request.json();
    } catch {
      throw createApiError("INVALID_REQUEST");
    }

    throw createApiError("METHOD_NOT_ALLOWED");
  }).then(withAllowedMethods);
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

export const PUT = unsupportedMethod;
export const PATCH = unsupportedMethod;
export const DELETE = unsupportedMethod;
export const OPTIONS = unsupportedMethod;
