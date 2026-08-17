import assert from "node:assert/strict";
import test from "node:test";

import { buildProductTelemetryEvent } from "../../modules/operations/domain/telemetry-policy.ts";
import { ProductTelemetryPolicyError } from "../../modules/operations/domain/telemetry-contract.ts";
import retention from "../../schema/operations/product-telemetry-retention.v1.json" with { type: "json" };

const UUID = "11111111-1111-4111-8111-111111111111";
const base = {
  event_name: "product.command.completed.v1",
  event_version: 1,
  schema_version: "product_telemetry_v1",
  policy_version: "hk_privacy_telemetry_v1",
  occurred_at: "2026-08-12T10:00:00.000Z",
  organization_id: UUID,
  actor_id: UUID,
  actor_role: "advisor",
  request_id: "req-privacy",
  session_id: UUID,
  case_id: UUID,
  job_id: null,
  route_template: "/api/v1/cases/[caseId]/commands",
  result_code: "succeeded",
  error_code: null,
  retryable: false,
  duration_ms: 1,
  build_version: "build-001",
};

function expectCode(input: Record<string, unknown>, code: string): void {
  assert.throws(() => buildProductTelemetryEvent(input), (error: unknown) =>
    error instanceof ProductTelemetryPolicyError && error.code === code,
  );
}

test("retention manifest is HK-only, 30-day, and separate from audit", () => {
  assert.equal(retention.retentionDays, 30);
  assert.equal(retention.residency, "aws:ap-east-1");
  assert.equal(retention.auditSeparated, true);
  assert.equal(retention.authorizationSource, false);
  assert.equal(retention.businessTruth, false);
  assert.equal(retention.deterministicGateSource, false);
});

test("rejects common PII, secret, and capture attempts", () => {
  for (const [key, value] of [
    ["email", "student@example.test"],
    ["phone", "+852 9123 4567"],
    ["note", "private child note"],
    ["token", "Bearer secret"],
    ["query", "student=one"],
  ] as const) {
    expectCode({ ...base, [key]: value }, "PII_POLICY_REJECTED");
  }
});

test("rejects alternate schema/policy versions and nested capture", () => {
  expectCode({ ...base, schema_version: "product_telemetry_v0" }, "TELEMETRY_SCHEMA_VERSION_UNSUPPORTED");
  expectCode({ ...base, policy_version: "other_policy" }, "TELEMETRY_POLICY_VERSION_UNSUPPORTED");
  expectCode({ ...base, metadata: { safe: true } }, "TELEMETRY_VALUE_INVALID");
});
