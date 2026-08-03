import assert from "node:assert/strict";
import test from "node:test";

import {
  DELETE as deleteHealth,
  GET as getHealth,
  OPTIONS as optionsHealth,
  PATCH as patchHealth,
  POST as postHealth,
  PUT as putHealth,
} from "../../app/api/v1/health/route.ts";
import {
  API_VERSION,
  createApiError,
  errorResponse,
  successResponse,
} from "../../modules/shared/api-contract.ts";
import { createRequestContext } from "../../modules/shared/request-context.ts";

test("creates an authoritative request context without trusting a caller request ID", () => {
  const context = createRequestContext(
    new Request("https://erp.example.test/api/v1/health", {
      headers: { "x-request-id": "req_01J0-safe.id" },
    }),
    {
      createRequestId: () => "generated-id",
      now: () => new Date("2026-08-01T00:00:00.000Z"),
    },
  );

  assert.deepEqual(context, {
    requestId: "generated-id",
    receivedAt: "2026-08-01T00:00:00.000Z",
  });
});

test("never echoes a PII-shaped caller request ID", () => {
  const context = createRequestContext(
    new Request("https://erp.example.test/api/v1/health", {
      headers: { "x-request-id": "student@example.test" },
    }),
    { createRequestId: () => "generated-safe-id" },
  );

  assert.equal(context.requestId, "generated-safe-id");
});

test("rejects non-finite JSON values instead of silently serializing null", () => {
  const context = createRequestContext(new Request("https://erp.example.test"), {
    createRequestId: () => "req-non-finite",
  });

  assert.throws(
    () => successResponse(context, { score: Number.NaN }),
    new TypeError("API response data must contain only finite JSON numbers."),
  );
});

test("serializes a versioned success envelope with no-store headers", async () => {
  const context = createRequestContext(new Request("https://erp.example.test"), {
    createRequestId: () => "req-success",
  });
  const response = successResponse(context, { status: "ok" });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-request-id"), "req-success");
  assert.deepEqual(await response.json(), {
    api_version: API_VERSION,
    request_id: "req-success",
    data: { status: "ok" },
  });
});

test("rejects a success envelope with a non-2xx status", () => {
  const context = createRequestContext(new Request("https://erp.example.test"), {
    createRequestId: () => "req-invalid-success-status",
  });

  assert.throws(
    () => successResponse(context, { status: "ok" }, 500),
    new RangeError("Success responses require a 2xx status that permits a JSON body."),
  );
});

test("maps stable errors to status, safe message, details, and retryability", async () => {
  const context = createRequestContext(new Request("https://erp.example.test"), {
    createRequestId: () => "req-stale",
  });
  const response = errorResponse(
    context,
    createApiError("STALE_VERSION", {
      details: {
        current_version: 7,
        raw_error: "DATABASE_URL=secret Student Jane Doe",
      },
    }),
  );

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    api_version: API_VERSION,
    error: {
      code: "STALE_VERSION",
      message: "The resource changed. Refresh and retry your update.",
      request_id: "req-stale",
      retryable: false,
      details: { current_version: 7 },
    },
  });
});

test("maps an invalid request to a safe versioned 400 envelope", async () => {
  const context = createRequestContext(new Request("https://erp.example.test"), {
    createRequestId: () => "req-invalid",
  });
  const response = errorResponse(context, createApiError("INVALID_REQUEST"));

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    api_version: API_VERSION,
    error: {
      code: "INVALID_REQUEST",
      message: "The request is invalid.",
      request_id: "req-invalid",
      retryable: false,
      details: {},
    },
  });
});

test("maps service unavailability to an explicitly retryable 503", async () => {
  const context = createRequestContext(new Request("https://erp.example.test"), {
    createRequestId: () => "req-unavailable",
  });
  const response = errorResponse(context, createApiError("SERVICE_UNAVAILABLE"));
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.error.retryable, true);
});

test("never exposes an unknown exception message or stack", async () => {
  const context = createRequestContext(new Request("https://erp.example.test"), {
    createRequestId: () => "req-internal",
  });
  const rawError = new Error("DATABASE_URL=secret Student Jane Doe");
  const response = errorResponse(context, rawError);
  const serialized = JSON.stringify(await response.json());

  assert.equal(response.status, 500);
  assert.equal(serialized.includes(rawError.message), false);
  assert.equal(serialized.includes("secret"), false);
  assert.equal(serialized.includes("Jane Doe"), false);
  assert.deepEqual(JSON.parse(serialized), {
    api_version: API_VERSION,
    error: {
      code: "INTERNAL_ERROR",
      message: "An unexpected error occurred.",
      request_id: "req-internal",
      retryable: false,
      details: {},
    },
  });
});

test("health route uses the shared envelope and an authoritative request ID", async () => {
  const response = getHealth(
    new Request("https://erp.example.test/api/v1/health", {
      headers: { "x-request-id": "health-check-01" },
    }),
  );

  const resolvedResponse = await response;

  assert.equal(resolvedResponse.status, 200);
  assert.equal(resolvedResponse.headers.get("cache-control"), "no-store");
  const body = await resolvedResponse.json();
  assert.match(body.request_id, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
  assert.notEqual(body.request_id, "health-check-01");
  assert.deepEqual(body, {
    api_version: API_VERSION,
    request_id: body.request_id,
    data: { status: "ok" },
  });
});

test("health route maps malformed JSON to the shared invalid-request envelope", async () => {
  const response = await postHealth(
    new Request("https://erp.example.test/api/v1/health", {
      method: "POST",
      body: "{broken",
      headers: { "content-type": "application/json" },
    }),
  );

  assert.equal(response.status, 400);
  const body = await response.json();
  assert.match(body.error.request_id, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
  assert.deepEqual(body, {
    api_version: API_VERSION,
    error: {
      code: "INVALID_REQUEST",
      message: "The request is invalid.",
      request_id: body.error.request_id,
      retryable: false,
      details: {},
    },
  });
});

test("health route maps unsupported methods to a versioned 405 envelope", async () => {
  const response = await postHealth(
    new Request("https://erp.example.test/api/v1/health", {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
    }),
  );

  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET");
  const body = await response.json();
  assert.match(body.error.request_id, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
  assert.deepEqual(body, {
    api_version: API_VERSION,
    error: {
      code: "METHOD_NOT_ALLOWED",
      message: "The request method is not allowed.",
      request_id: body.error.request_id,
      retryable: false,
      details: {},
    },
  });
});

test("health route explicitly maps every unsupported body-capable method", async () => {
  const handlers = [putHealth, patchHealth, deleteHealth, optionsHealth];

  for (const handler of handlers) {
    const response = await handler(new Request("https://erp.example.test/api/v1/health"));
    const body = await response.json();

    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "GET");
    assert.equal(body.api_version, API_VERSION);
    assert.equal(body.error.code, "METHOD_NOT_ALLOWED");
    assert.equal(body.error.retryable, false);
  }
});
