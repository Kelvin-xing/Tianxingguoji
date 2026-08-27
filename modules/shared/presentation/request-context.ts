export interface RequestContext {
  readonly requestId: string;
  readonly receivedAt: string;
  readonly correlationId?: string;
  readonly causationId?: string;
}

export interface RequestContextDependencies {
  readonly createRequestId?: () => string;
  readonly now?: () => Date;
  readonly correlationId?: string;
  readonly causationId?: string;
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
  for (const propagatedId of [dependencies.correlationId, dependencies.causationId]) {
    if (propagatedId !== undefined && !SAFE_REQUEST_ID.test(propagatedId)) {
      throw new Error("Trusted request context contained an unsafe value");
    }
  }

  return Object.freeze({
    requestId,
    receivedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
    ...(dependencies.correlationId === undefined
      ? {} : { correlationId: dependencies.correlationId }),
    ...(dependencies.causationId === undefined
      ? {} : { causationId: dependencies.causationId }),
  });
}

function defaultRequestId(): string {
  return crypto.randomUUID();
}
