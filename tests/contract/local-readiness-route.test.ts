import assert from "node:assert/strict";
import test from "node:test";

import { handleLocalReadinessRequest } from "../../app/api/v1/local/readiness/route.ts";
import { API_VERSION } from "../../modules/shared/presentation/api-contract.ts";
import type { LocalSyntheticReadinessReport } from "../../lib/runtime/local-synthetic-readiness.ts";

test("local readiness returns a versioned dependency report only in local mode", async () => {
  const response = await handleLocalReadinessRequest(request(), {
    environment: { APP_RUNTIME_MODE: "local-synthetic" },
    checkReadiness: async () => report("ready"),
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(body.api_version, API_VERSION);
  assert.deepEqual(body.data, {
    mode: "local-synthetic",
    status: "ready",
    dependencies: {
      postgresql: "ready",
      postgresql_identity: "ready",
      localstack_s3: "ready",
      localstack_sqs: "ready",
      clamav: "ready",
    },
  });
});

test("local readiness is hidden outside local mode", async () => {
  let called = false;
  const response = await handleLocalReadinessRequest(request(), {
    environment: { APP_RUNTIME_MODE: "production-aws", NODE_ENV: "production" },
    checkReadiness: async () => {
      called = true;
      return report("ready");
    },
  });
  const body = await response.json();

  assert.equal(response.status, 404);
  assert.equal(body.error.code, "NOT_FOUND");
  assert.equal(called, false);
});

test("local readiness maps unavailable services to a safe 503", async () => {
  const response = await handleLocalReadinessRequest(request(), {
    environment: { APP_RUNTIME_MODE: "local-synthetic" },
    checkReadiness: async () => ({
      ...report("not_ready"),
      dependencies: {
        postgresql: "ready",
        postgresql_identity: "ready",
        localstack_s3: "ready",
        localstack_sqs: "unavailable",
        clamav: "unavailable",
      },
    }),
  });
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.error.code, "SERVICE_UNAVAILABLE");
  assert.equal(body.error.retryable, true);
  assert.deepEqual(body.error.details, {
    dependencies: {
      postgresql: "ready",
      postgresql_identity: "ready",
      localstack_s3: "ready",
      localstack_sqs: "unavailable",
      clamav: "unavailable",
    },
  });
  assert.equal(JSON.stringify(body).includes("127.0.0.1"), false);
});

function request(): Request {
  return new Request("http://localhost:3000/api/v1/local/readiness");
}

function report(status: "ready" | "not_ready"): LocalSyntheticReadinessReport {
  return {
    mode: "local-synthetic",
    status,
    dependencies: {
      postgresql: "ready",
      postgresql_identity: "ready",
      localstack_s3: "ready",
      localstack_sqs: "ready",
      clamav: "ready",
    },
  };
}
