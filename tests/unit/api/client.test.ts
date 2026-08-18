import assert from "node:assert/strict";
import test from "node:test";

import { ApiClientError, expectRecord, expectString, requestApi } from "../../../lib/api/client.ts";

test("decodes the v1 envelope and sends same-origin request metadata", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (input, init) => {
    assert.equal(input, "/api/v1/example");
    assert.equal(init?.credentials, "same-origin");
    assert.equal(new Headers(init?.headers).get("accept"), "application/json");
    assert.match(new Headers(init?.headers).get("x-request-id") ?? "", /^[A-Za-z0-9]/);
    return Response.json(
      { api_version: "v1", request_id: "server-request", data: { value: "ok" } },
      { headers: { "x-request-id": "server-request" } },
    );
  };
  const result = await requestApi({ path: "/api/v1/example" }, (value) => expectString(expectRecord(value).value));
  assert.equal(result, "ok");
});

test("normalizes API errors without retaining messages or response bodies", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => Response.json({
    error: {
      code: "CONFLICT",
      message: "database and stack details must not escape",
      request_id: "request-safe-1",
      retryable: false,
      details: { stack: "secret" },
    },
  }, { status: 409 });

  await assert.rejects(
    requestApi({ path: "/api/v1/example", responseMode: "raw" }, expectRecord),
    (error: unknown) => {
      assert.ok(error instanceof ApiClientError);
      assert.deepEqual(
        { code: error.code, status: error.status, retryable: error.retryable, requestId: error.requestId },
        { code: "CONFLICT", status: 409, retryable: false, requestId: "request-safe-1" },
      );
      assert.equal(error.message, "API request failed.");
      assert.equal("details" in error, false);
      return true;
    },
  );
});

test("maps non-JSON, network, timeout, and caller cancellation safely", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });

  globalThis.fetch = async () => new Response("upstream html", { status: 503, headers: { "content-type": "text/html" } });
  await rejectsWithCode(requestApi({ path: "/api/v1/example" }, expectRecord), "MALFORMED_RESPONSE");

  globalThis.fetch = async () => { throw new Error("socket detail"); };
  await rejectsWithCode(requestApi({ path: "/api/v1/example" }, expectRecord), "NETWORK_ERROR");

  globalThis.fetch = async (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  });
  await rejectsWithCode(requestApi({ path: "/api/v1/example", timeoutMs: 5 }, expectRecord), "REQUEST_TIMEOUT");

  const controller = new AbortController();
  const pending = requestApi({ path: "/api/v1/example", signal: controller.signal }, expectRecord);
  controller.abort();
  await rejectsWithCode(pending, "REQUEST_ABORTED");

  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  await rejectsWithCode(
    requestApi({ path: "/api/v1/example", signal: alreadyAborted.signal }, expectRecord),
    "REQUEST_ABORTED",
  );
});

test("rejects paths that URL parsing could reinterpret as cross-origin", async () => {
  await rejectsWithCode(requestApi({ path: "//outside.example" }, expectRecord), "INVALID_CLIENT_REQUEST");
  await rejectsWithCode(requestApi({ path: "/\\outside.example" }, expectRecord), "INVALID_CLIENT_REQUEST");
});

test("rejects malformed envelopes and decoder failures with the local request ID", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  let outgoingRequestId = "";
  globalThis.fetch = async (_input, init) => {
    outgoingRequestId = new Headers(init?.headers).get("x-request-id") ?? "";
    return Response.json({ api_version: "v1", request_id: "ignored", result: {} }, { status: 201 });
  };
  await assert.rejects(
    requestApi({ path: "/api/v1/example", method: "POST" }, expectRecord),
    (error: unknown) =>
      error instanceof ApiClientError &&
      error.code === "MALFORMED_RESPONSE" &&
      error.status === 201 &&
      error.requestId === outgoingRequestId,
  );

  globalThis.fetch = async (_input, init) => {
    outgoingRequestId = new Headers(init?.headers).get("x-request-id") ?? "";
    return Response.json({ api_version: "v1", request_id: "ignored", data: { value: 3 } });
  };
  await assert.rejects(
    requestApi({ path: "/api/v1/example" }, () => { throw new Error("decoder detail"); }),
    (error: unknown) =>
      error instanceof ApiClientError &&
      error.code === "MALFORMED_RESPONSE" &&
      error.requestId === outgoingRequestId &&
      error.message === "API request failed.",
  );
});

test("uses safe retryability for 429 and 5xx errors", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });

  for (const [status, expectedRetryable] of [[429, true], [500, true], [503, true]] as const) {
    globalThis.fetch = async () => Response.json({ error: { code: "UPSTREAM_FAILURE" } }, { status });
    await assert.rejects(
      requestApi({ path: "/api/v1/example", responseMode: "raw" }, expectRecord),
      (error: unknown) =>
        error instanceof ApiClientError &&
        error.status === status &&
        error.retryable === expectedRetryable,
    );
  }
});

async function rejectsWithCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof ApiClientError && error.code === code);
}
