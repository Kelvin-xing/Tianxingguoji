import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ALERT_CATALOGUE,
  ALERT_CATALOGUE_VERSION,
  AlertCatalogueError,
  buildAlertOccurrence,
  getAlertDefinition,
  isAlertStateTransitionAllowed,
} from "../../../modules/operations/domain/alert-catalogue.ts";

const REQUIRED_ALERTS = Object.freeze([
  "auth.failure_burst",
  "auth.revoke_backlog",
  "scan.stuck",
  "scan.dead_letter",
  "outbox.stuck",
  "privacy.pii_canary",
  "telemetry.sink_degraded",
  "region.hk_unhealthy",
  "dashboard.projection_mismatch",
  "budget.rds_monthly",
  "budget.s3_monthly",
  "budget.runtime_logging_monthly",
]);

test("every required alert has one complete immutable operational contract", () => {
  assert.deepEqual(ALERT_CATALOGUE.map((entry) => entry.alertId), REQUIRED_ALERTS);
  assert.equal(new Set(ALERT_CATALOGUE.map((entry) => entry.alertId)).size, ALERT_CATALOGUE.length);

  for (const entry of ALERT_CATALOGUE) {
    assert.equal(entry.catalogueVersion, ALERT_CATALOGUE_VERSION);
    assert.match(entry.detector.metricName, /^[a-z][a-z0-9_.]{2,127}$/);
    assert.ok(["gte", "eq"].includes(entry.detector.comparator));
    assert.ok(Number.isFinite(entry.detector.threshold));
    assert.ok(Number.isSafeInteger(entry.detector.windowSeconds));
    assert.ok(entry.detector.windowSeconds > 0);
    assert.ok(["warning", "high", "critical"].includes(entry.severity));
    assert.match(entry.owner, /^[a-z][a-z_]{2,63}$/);
    assert.match(entry.backupOwner, /^[a-z][a-z_]{2,63}$/);
    assert.notEqual(entry.owner, entry.backupOwner);
    assert.ok(["business_hours", "immediate_security", "hk_region_incident"].includes(entry.escalation));
    assert.match(entry.deduplication.dimension, /^[a-z][a-z0-9_+]{2,127}$/);
    assert.ok(entry.deduplication.cooldownSeconds >= 60);
    assert.match(entry.runbook, /^docs\/runbooks\/(auth|scan|outbox|pii|region|telemetry)\.md$/);
    assert.match(entry.stopState, /^[a-z][a-z0-9_]{2,127}$/);
    assert.equal(Object.isFrozen(entry), true);
    assert.equal(Object.isFrozen(entry.detector), true);
  }
});

test("OD-11 cost definitions preserve approved limits and 50/80/100 escalation levels", () => {
  const expected = {
    "budget.rds_monthly": 150,
    "budget.s3_monthly": 25,
    "budget.runtime_logging_monthly": 300,
  } as const;

  for (const [alertId, monthlyLimitUsd] of Object.entries(expected)) {
    const definition = getAlertDefinition(alertId, ALERT_CATALOGUE_VERSION);
    assert.equal(definition.monthlyLimitUsd, monthlyLimitUsd);
    assert.deepEqual(definition.budgetLevels, [
      { percent: 50, severity: "warning", stopState: "continue_monitoring" },
      { percent: 80, severity: "high", stopState: "founder_review_required" },
      { percent: 100, severity: "critical", stopState: "pause_nonessential_work" },
    ]);
  }
});

test("unknown alert identities and versions fail closed", () => {
  assert.throws(
    () => getAlertDefinition("auth.unknown", ALERT_CATALOGUE_VERSION),
    catalogueError("ALERT_UNKNOWN_DEFINITION"),
  );
  assert.throws(
    () => getAlertDefinition("auth.failure_burst", "alert_catalogue_v0"),
    catalogueError("ALERT_UNSUPPORTED_VERSION"),
  );
});

test("occurrence payload is catalogue-derived, typed, and PII-safe", () => {
  const occurrence = buildAlertOccurrence({
    alertId: "scan.dead_letter",
    catalogueVersion: ALERT_CATALOGUE_VERSION,
    occurrenceId: "alert-occurrence-20260810-001",
    requestId: "scan-reconcile-20260810-001",
    organizationId: "11111111-1111-4111-8111-111111111111",
    detectedAt: "2026-08-10T10:00:00.000Z",
    observedValue: 1,
    state: "firing",
  });

  assert.deepEqual(occurrence, {
    alert_id: "scan.dead_letter",
    catalogue_version: ALERT_CATALOGUE_VERSION,
    occurrence_id: "alert-occurrence-20260810-001",
    request_id: "scan-reconcile-20260810-001",
    organization_id: "11111111-1111-4111-8111-111111111111",
    detected_at: "2026-08-10T10:00:00.000Z",
    metric_name: "document_scan_dlq_count",
    observed_value: 1,
    threshold_value: 1,
    window_seconds: 60,
    severity: "critical",
    state: "firing",
  });
  assert.equal(Object.isFrozen(occurrence), true);
});

test("extra sensitive fields, malformed identifiers, and non-firing samples are rejected", () => {
  const base = {
    alertId: "privacy.pii_canary",
    catalogueVersion: ALERT_CATALOGUE_VERSION,
    occurrenceId: "alert-occurrence-20260810-002",
    requestId: "pii-scan-20260810-001",
    organizationId: null,
    detectedAt: "2026-08-10T10:00:00.000Z",
    observedValue: 1,
    state: "firing" as const,
  };

  for (const field of ["reason", "url", "object_key", "token", "content", "studentName"]) {
    assert.throws(
      () => buildAlertOccurrence({ ...base, [field]: "raw-sensitive-value" }),
      catalogueError("ALERT_PAYLOAD_FIELD_NOT_ALLOWED"),
    );
  }
  assert.throws(
    () => buildAlertOccurrence({ ...base, requestId: "https://example.test/private" }),
    catalogueError("ALERT_PAYLOAD_INVALID"),
  );
  assert.throws(
    () => buildAlertOccurrence({ ...base, observedValue: 0 }),
    catalogueError("ALERT_THRESHOLD_NOT_MET"),
  );
});

test("alert lifecycle permits bounded acknowledgement and makes close terminal", () => {
  assert.equal(isAlertStateTransitionAllowed("firing", "acknowledged"), true);
  assert.equal(isAlertStateTransitionAllowed("acknowledged", "mitigated"), true);
  assert.equal(isAlertStateTransitionAllowed("mitigated", "closed"), true);
  assert.equal(isAlertStateTransitionAllowed("firing", "needs_human"), true);
  assert.equal(isAlertStateTransitionAllowed("closed", "firing"), false);
  assert.equal(isAlertStateTransitionAllowed("firing", "closed"), false);
});

test("every linked runbook contains the actionable operator contract", async () => {
  const requiredHeadings = [
    "## Trigger",
    "## Stop State",
    "## Safe Evidence",
    "## Triage",
    "## Recovery And Close",
    "## Escalation And Terminal States",
  ];

  for (const path of new Set(ALERT_CATALOGUE.map((entry) => entry.runbook))) {
    const text = await readFile(new URL(`../../../${path}`, import.meta.url), "utf8");
    for (const heading of requiredHeadings) assert.match(text, new RegExp(`^${heading}$`, "m"));
    assert.match(text, /No alert authorizes remediation, replay, purge, restore, cloud changes, or warning acceptance\./);
  }
});

function catalogueError(code: string) {
  return (error: unknown) => error instanceof AlertCatalogueError && error.code === code;
}
