import assert from "node:assert/strict";
import test from "node:test";

import {
  ProductTelemetryPolicyError,
  TELEMETRY_POLICY_VERSION,
  TELEMETRY_SCHEMA_VERSION,
} from "../../../modules/operations/telemetry-contract.ts";
import { buildProductTelemetryEvent } from "../../../modules/operations/telemetry-policy.ts";

const UUID = "11111111-1111-4111-8111-111111111111";

function routeEvent(overrides: Record<string, unknown> = {}) {
  return {
    event_name: "product.route.completed.v1",
    event_version: 1,
    schema_version: TELEMETRY_SCHEMA_VERSION,
    policy_version: TELEMETRY_POLICY_VERSION,
    occurred_at: "2026-08-12T10:00:00.000Z",
    organization_id: UUID,
    actor_id: UUID,
    actor_role: "advisor",
    request_id: "req-001",
    session_id: UUID,
    case_id: null,
    job_id: null,
    route_template: "/api/v1/cases/[caseId]",
    result_code: "succeeded",
    error_code: null,
    retryable: false,
    duration_ms: 42,
    build_version: "build-001",
    ...overrides,
  };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
    return "NO_ERROR";
  } catch (error) {
    assert.ok(error instanceof ProductTelemetryPolicyError);
    return error.code;
  }
}

test("builds a frozen route event with the exact closed schema", () => {
  const event = buildProductTelemetryEvent(routeEvent());
  assert.equal(event.route_template, "/api/v1/cases/[caseId]");
  assert.equal(Object.isFrozen(event), true);
  assert.deepEqual(Object.keys(event).sort(), [
    "actor_id", "actor_role", "build_version", "case_id", "duration_ms", "error_code",
    "event_name", "event_version", "job_id", "occurred_at", "organization_id", "policy_version",
    "request_id", "result_code", "retryable", "route_template", "schema_version", "session_id",
  ].sort());
});

test("rejects unknown fields instead of silently dropping them", () => {
  assert.equal(codeOf(() => buildProductTelemetryEvent(routeEvent({ metadata: "x" }))), "TELEMETRY_FIELD_NOT_ALLOWED");
  assert.equal(codeOf(() => buildProductTelemetryEvent(routeEvent({ student_name: "x" }))), "PII_POLICY_REJECTED");
});

test("rejects nested capture, query routes, and inconsistent outcome", () => {
  assert.equal(codeOf(() => buildProductTelemetryEvent(routeEvent({ metadata: { safe: true } }))), "TELEMETRY_VALUE_INVALID");
  assert.equal(codeOf(() => buildProductTelemetryEvent(routeEvent({ route_template: "/api/v1/cases?student=1" }))), "TELEMETRY_VALUE_INVALID");
  assert.equal(codeOf(() => buildProductTelemetryEvent(routeEvent({ result_code: "failed", error_code: null }))), "TELEMETRY_VALUE_INVALID");
});

test("requires job context and forbids user context for job events", () => {
  const job = routeEvent({
    event_name: "product.job.completed.v1",
    organization_id: null,
    actor_id: null,
    actor_role: null,
    session_id: null,
    case_id: null,
    job_id: UUID,
    route_template: null,
  });
  assert.equal(buildProductTelemetryEvent(job).job_id, UUID);
  assert.equal(codeOf(() => buildProductTelemetryEvent({ ...job, job_id: null })), "TELEMETRY_CONTEXT_INVALID");
});
