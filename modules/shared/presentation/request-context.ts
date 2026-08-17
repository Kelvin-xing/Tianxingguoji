export interface RequestContext {
  readonly requestId: string;
  readonly receivedAt: string;
}

export interface RequestContextDependencies {
  readonly createRequestId?: () => string;
  readonly now?: () => Date;
}

const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function createRequestContext(
  _request: Request,
  dependencies: RequestContextDependencies = {},
): RequestContext {
  const requestId = (dependencies.createRequestId ?? defaultRequestId)();

  if (!SAFE_REQUEST_ID.test(requestId)) {
    throw new Error("Request ID generator returned an unsafe value");
  }

  return Object.freeze({
    requestId,
    receivedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
  });
}

function defaultRequestId(): string {
  return crypto.randomUUID();
}
