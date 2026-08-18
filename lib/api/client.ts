export type ApiResponseMode = "envelope" | "raw";

export type ApiRequestBody =
  | string
  | number
  | boolean
  | null
  | readonly ApiRequestBody[]
  | { readonly [key: string]: ApiRequestBody };

export interface ApiRequest {
  readonly path: `/${string}`;
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly body?: ApiRequestBody;
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly responseMode?: ApiResponseMode;
}

export type ApiDecoder<T> = (value: unknown) => T;

export class ApiClientError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly requestId: string | null;

  constructor(input: {
    readonly code: string;
    readonly status: number;
    readonly retryable: boolean;
    readonly requestId: string | null;
  }) {
    super("API request failed.");
    this.name = "ApiClientError";
    this.code = safeCode(input.code) ? input.code : "UNEXPECTED_ERROR";
    this.status = Number.isInteger(input.status) && input.status >= 0 ? input.status : 0;
    this.retryable = input.retryable;
    this.requestId = safeRequestId(input.requestId) ? input.requestId : null;
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;

export async function requestApi<T>(request: ApiRequest, decoder: ApiDecoder<T>): Promise<T> {
  if (!isSameOriginPath(request.path)) {
    throw clientError("INVALID_CLIENT_REQUEST");
  }

  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw clientError("INVALID_CLIENT_REQUEST");
  }

  const requestId = createRequestId();
  if (request.signal?.aborted) {
    throw new ApiClientError({ code: "REQUEST_ABORTED", status: 0, retryable: false, requestId });
  }

  const controller = new AbortController();
  let abortReason: "caller" | "timeout" | null = null;
  const abortFromCaller = () => {
    if (!controller.signal.aborted) {
      abortReason = "caller";
      controller.abort();
    }
  };
  request.signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = setTimeout(() => {
    if (!controller.signal.aborted) {
      abortReason = "timeout";
      controller.abort();
    }
  }, timeoutMs);

  const headers = new Headers(request.headers);
  headers.set("accept", "application/json");
  headers.set("x-request-id", requestId);
  if (request.body !== undefined) headers.set("content-type", "application/json");

  try {
    const response = await fetch(request.path, {
      method: request.method ?? "GET",
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      headers,
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal,
    });
    const responseRequestId = readRequestId(response.headers.get("x-request-id")) ?? requestId;
    const payload = await parseJsonResponse(response, responseRequestId);

    if (!response.ok) throw decodeApiError(payload, response.status, responseRequestId);

    try {
      const value = request.responseMode === "raw"
        ? payload
        : decodeEnvelope(payload, response.status, responseRequestId);
      return decoder(value);
    } catch (error) {
      if (error instanceof ApiClientError) throw error;
      throw new ApiClientError({
        code: "MALFORMED_RESPONSE",
        status: response.status,
        retryable: false,
        requestId: responseRequestId,
      });
    }
  } catch (error) {
    if (error instanceof ApiClientError) throw error;
    if (controller.signal.aborted) {
      throw new ApiClientError({
        code: abortReason === "timeout" ? "REQUEST_TIMEOUT" : "REQUEST_ABORTED",
        status: 0,
        retryable: abortReason === "timeout",
        requestId,
      });
    }
    throw new ApiClientError({ code: "NETWORK_ERROR", status: 0, retryable: true, requestId });
  } finally {
    clearTimeout(timeout);
    request.signal?.removeEventListener("abort", abortFromCaller);
  }
}

export function expectRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Expected an object.");
  }
  return value as Readonly<Record<string, unknown>>;
}

export function expectString(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("Expected a string.");
  return value;
}

export function expectNullableString(value: unknown): string | null {
  if (value === null) return null;
  return expectString(value);
}

export function expectNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError("Expected a finite number.");
  return value;
}

export function expectBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new TypeError("Expected a boolean.");
  return value;
}

export function expectArray<T>(value: unknown, decoder: ApiDecoder<T>): readonly T[] {
  if (!Array.isArray(value)) throw new TypeError("Expected an array.");
  return value.map(decoder);
}

function decodeEnvelope(payload: unknown, status: number, fallbackRequestId: string | null): unknown {
  const envelope = expectRecord(payload);
  if (envelope.api_version !== "v1" || !("data" in envelope)) {
    throw new ApiClientError({ code: "MALFORMED_RESPONSE", status, retryable: false, requestId: fallbackRequestId });
  }
  return envelope.data;
}

async function parseJsonResponse(response: Response, requestId: string | null): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new ApiClientError({ code: "MALFORMED_RESPONSE", status: response.status, retryable: response.status >= 500, requestId });
  }
  if (!contentType.includes("application/json") || text.trim() === "") {
    throw new ApiClientError({ code: "MALFORMED_RESPONSE", status: response.status, retryable: response.status >= 500, requestId });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiClientError({ code: "MALFORMED_RESPONSE", status: response.status, retryable: response.status >= 500, requestId });
  }
}

function decodeApiError(payload: unknown, status: number, fallbackRequestId: string | null): ApiClientError {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return new ApiClientError({ code: "UNEXPECTED_ERROR", status, retryable: status >= 500, requestId: fallbackRequestId });
  }
  const root = payload as Readonly<Record<string, unknown>>;
  const error = root.error;
  if (typeof error !== "object" || error === null || Array.isArray(error)) {
    return new ApiClientError({ code: "UNEXPECTED_ERROR", status, retryable: status >= 500, requestId: fallbackRequestId });
  }
  const record = error as Readonly<Record<string, unknown>>;
  const code = typeof record.code === "string" && safeCode(record.code) ? record.code : "UNEXPECTED_ERROR";
  const retryable = typeof record.retryable === "boolean" ? record.retryable : status === 429 || status >= 500;
  const requestId = typeof record.request_id === "string" ? readRequestId(record.request_id) : fallbackRequestId;
  return new ApiClientError({ code, status, retryable, requestId });
}

function createRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `web-${Date.now().toString(36)}`;
}

function readRequestId(value: string | null): string | null {
  return safeRequestId(value) ? value : null;
}

function safeRequestId(value: string | null): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function safeCode(value: string): boolean {
  return /^[A-Z][A-Z0-9_]{0,127}$/.test(value);
}

function isSameOriginPath(value: string): boolean {
  return /^\/(?!\/)[^\\\u0000-\u001f\u007f]*$/.test(value);
}

function clientError(code: string): ApiClientError {
  return new ApiClientError({ code, status: 0, retryable: false, requestId: null });
}
