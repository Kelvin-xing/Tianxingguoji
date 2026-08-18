import { createRequestContext, type RequestContext } from "./request-context.ts";

export const API_VERSION = "v1" as const;

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type ApiErrorCode =
  | "INVALID_REQUEST"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "METHOD_NOT_ALLOWED"
  | "CONFLICT"
  | "STALE_VERSION"
  | "VALIDATION_FAILED"
  | "RATE_LIMITED"
  | "SERVICE_UNAVAILABLE"
  | "INTERNAL_ERROR";

interface ApiErrorDefinition {
  readonly status: 400 | 401 | 403 | 404 | 405 | 409 | 422 | 429 | 500 | 503;
  readonly message: string;
  readonly retryable: boolean;
}

const ERROR_DEFINITIONS = Object.freeze({
  INVALID_REQUEST: {
    status: 400,
    message: "The request is invalid.",
    retryable: false,
  },
  UNAUTHENTICATED: {
    status: 401,
    message: "Authentication is required.",
    retryable: false,
  },
  FORBIDDEN: {
    status: 403,
    message: "You are not allowed to perform this action.",
    retryable: false,
  },
  NOT_FOUND: {
    status: 404,
    message: "The requested resource was not found.",
    retryable: false,
  },
  METHOD_NOT_ALLOWED: {
    status: 405,
    message: "The request method is not allowed.",
    retryable: false,
  },
  CONFLICT: {
    status: 409,
    message: "The request conflicts with the current resource state.",
    retryable: false,
  },
  STALE_VERSION: {
    status: 409,
    message: "The resource changed. Refresh and retry your update.",
    retryable: false,
  },
  VALIDATION_FAILED: {
    status: 422,
    message: "The request did not pass validation.",
    retryable: false,
  },
  RATE_LIMITED: {
    status: 429,
    message: "The request limit was reached. Retry later.",
    retryable: true,
  },
  SERVICE_UNAVAILABLE: {
    status: 503,
    message: "The service is temporarily unavailable.",
    retryable: true,
  },
  INTERNAL_ERROR: {
    status: 500,
    message: "An unexpected error occurred.",
    retryable: false,
  },
} as const satisfies Readonly<Record<ApiErrorCode, ApiErrorDefinition>>);

export class ApiContractError extends Error {
  readonly code: ApiErrorCode;
  readonly details: Readonly<Record<string, JsonValue>>;

  constructor(code: ApiErrorCode, details: Readonly<Record<string, JsonValue>> = {}) {
    super(ERROR_DEFINITIONS[code].message);
    this.name = "ApiContractError";
    this.code = code;
    this.details = sanitizeErrorDetails(code, details);
  }
}

export function createApiError(
  code: Exclude<ApiErrorCode, "INTERNAL_ERROR">,
  options: { readonly details?: Readonly<Record<string, JsonValue>> } = {},
): ApiContractError {
  return new ApiContractError(code, options.details);
}

export function successResponse<T extends JsonValue>(
  context: RequestContext,
  data: T,
  status = 200,
): Response {
  if (
    !Number.isInteger(status) ||
    status < 200 ||
    status >= 300 ||
    status === 204 ||
    status === 205
  ) {
    throw new RangeError("Success responses require a 2xx status that permits a JSON body.");
  }
  assertFiniteJsonNumbers(data);

  return jsonResponse(
    context,
    {
      api_version: API_VERSION,
      request_id: context.requestId,
      data,
    },
    status,
  );
}

export async function handleApiRequest<T extends JsonValue>(
  request: Request,
  operation: (context: RequestContext) => T | Promise<T>,
): Promise<Response> {
  const context = createRequestContext(request);

  try {
    return successResponse(context, await operation(context));
  } catch (error) {
    return errorResponse(context, error);
  }
}

export function errorResponse(context: RequestContext, error: unknown): Response {
  const contractError =
    error instanceof ApiContractError ? error : new ApiContractError("INTERNAL_ERROR");
  const definition = ERROR_DEFINITIONS[contractError.code];

  return jsonResponse(
    context,
    {
      api_version: API_VERSION,
      error: {
        code: contractError.code,
        message: definition.message,
        request_id: context.requestId,
        retryable: definition.retryable,
        details: contractError.details,
      },
    },
    definition.status,
  );
}

function sanitizeErrorDetails(
  code: ApiErrorCode,
  details: Readonly<Record<string, JsonValue>>,
): Readonly<Record<string, JsonValue>> {
  if (code === "SERVICE_UNAVAILABLE") {
    return sanitizeDependencyReadiness(details.dependencies);
  }
  if (code !== "STALE_VERSION") {
    return Object.freeze({});
  }

  const safeDetails: Record<string, JsonValue> = {};
  const currentVersion = details.current_version;
  if (
    (typeof currentVersion === "number" &&
      Number.isSafeInteger(currentVersion) &&
      currentVersion >= 0) ||
    (typeof currentVersion === "string" && /^\d{1,20}$/.test(currentVersion))
  ) {
    safeDetails.current_version = currentVersion;
  }

  const diffToken = details.diff_token;
  if (typeof diffToken === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(diffToken)) {
    safeDetails.diff_token = diffToken;
  }

  return Object.freeze(safeDetails);
}

function sanitizeDependencyReadiness(value: JsonValue | undefined): Readonly<Record<string, JsonValue>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return Object.freeze({});
  }
  const dependencyRecord = value as { readonly [key: string]: JsonValue };

  const allowedDependencies = [
    "postgresql",
    "postgresql_identity",
    "localstack_s3",
    "localstack_sqs",
    "clamav",
  ] as const;
  const dependencies: Record<string, JsonValue> = {};
  for (const name of allowedDependencies) {
    const state = dependencyRecord[name];
    if (state !== "ready" && state !== "unavailable") {
      return Object.freeze({});
    }
    dependencies[name] = state;
  }

  return Object.freeze({ dependencies: Object.freeze(dependencies) });
}

function jsonResponse(
  context: RequestContext,
  body: JsonValue,
  status: number,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-request-id": context.requestId,
    },
  });
}

function assertFiniteJsonNumbers(value: JsonValue): void {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("API response data must contain only finite JSON numbers.");
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      assertFiniteJsonNumbers(item);
    }
    return;
  }

  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) {
      assertFiniteJsonNumbers(item);
    }
  }
}
