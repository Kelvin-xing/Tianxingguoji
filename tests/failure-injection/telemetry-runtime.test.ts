import assert from "node:assert/strict";
import test from "node:test";

import { buildAuditEvent } from "../../modules/audit/contract.ts";
import {
  MandatoryAuditUnavailableError,
  ProductTelemetryService,
} from "../../modules/operations/telemetry-service.ts";
import {
  TELEMETRY_POLICY_VERSION,
  TELEMETRY_SCHEMA_VERSION,
} from "../../modules/operations/telemetry-contract.ts";
import type { TelemetryOperationsStateAdapter } from "../../modules/operations/telemetry-service.ts";
import {
  FakeMandatoryAuditTransaction,
  FakeTelemetryOperationsState,
  FakeTelemetrySink,
} from "../fakes/telemetry.ts";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR_ID = "22222222-2222-4222-8222-222222222222";
const CASE_ID = "33333333-3333-4333-8333-333333333333";
const AUDIT_ID = "44444444-4444-4444-8444-444444444444";
const REQUEST_ID = "telemetry-runtime-001";
const TIMESTAMP = "2026-08-12T10:00:00.000Z";

function routeEvent(overrides: Record<string, unknown> = {}) {
  return {
    event_name: "product.command.completed.v1",
    event_version: 1,
    schema_version: TELEMETRY_SCHEMA_VERSION,
    policy_version: TELEMETRY_POLICY_VERSION,
    occurred_at: TIMESTAMP,
    organization_id: ORGANIZATION_ID,
    actor_id: ACTOR_ID,
    actor_role: "advisor",
    request_id: REQUEST_ID,
    session_id: ACTOR_ID,
    case_id: CASE_ID,
    job_id: null,
    route_template: "/api/v1/cases/[caseId]/commands",
    result_code: "succeeded",
    error_code: null,
    retryable: false,
    duration_ms: 12,
    build_version: "build-p3-06",
    ...overrides,
  };
}

function createService(input: {
  readonly sink?: FakeTelemetrySink;
  readonly operationsState?: TelemetryOperationsStateAdapter;
  readonly createAlertOccurrenceId?: () => string;
}) {
  const sink = input.sink ?? new FakeTelemetrySink();
  const operationsState = input.operationsState ?? new FakeTelemetryOperationsState();
  const service = new ProductTelemetryService({
    sink,
    operationsState,
    now: () => new Date("2026-08-12T10:00:01.000Z"),
    createAlertOccurrenceId: input.createAlertOccurrenceId ?? (() => "telemetry-alert-001"),
  });
  return { service, sink, operationsState };
}

test("delivers only policy-approved events and does not hide policy rejection", async () => {
  const { service, sink } = createService({});

  const result = await service.emit(routeEvent());
  assert.equal(result.status, "delivered");
  assert.equal(sink.delivered.length, 1);
  assert.equal(sink.delivered[0]?.request_id, REQUEST_ID);

  await assert.rejects(
    service.emit(routeEvent({ metadata: { unsafe: true } })),
    /TELEMETRY_VALUE_INVALID|TELEMETRY_FIELD_NOT_ALLOWED/,
  );
  assert.equal(sink.attempts.length, 1);
});

test("sink outage fails open, enters degraded state, and never replays the business event", async () => {
  const sink = new FakeTelemetrySink();
  sink.failWrites = true;
  const operationsState = new FakeTelemetryOperationsState();
  const { service } = createService({ sink, operationsState });

  const dropped = await service.emit(routeEvent());
  assert.deepEqual(
    {
      status: dropped.status,
      failureCode: dropped.status === "dropped" ? dropped.failureCode : null,
      degradedState: dropped.status === "dropped" ? dropped.degradedState : null,
      alertReceipt: dropped.status === "dropped" ? dropped.alertReceipt : null,
    },
    {
      status: "dropped",
      failureCode: "TELEMETRY_SINK_UNAVAILABLE",
      degradedState: "recorded",
      alertReceipt: "created",
    },
  );
  assert.equal(operationsState.state.state, "degraded");
  assert.equal(operationsState.alerts.length, 1);

  sink.failWrites = false;
  const nextEvent = await service.emit(routeEvent({ request_id: "telemetry-runtime-002" }));
  assert.equal(nextEvent.status, "delivered");
  assert.equal(sink.attempts.length, 2);
  assert.equal(sink.delivered.length, 1);
  assert.equal(sink.delivered[0]?.request_id, "telemetry-runtime-002");
  assert.equal(operationsState.alerts.length, 1);
});

test("degraded alert creation is deduplicated and recovery requires a successful probe", async () => {
  const sink = new FakeTelemetrySink();
  sink.failWrites = true;
  const operationsState = new FakeTelemetryOperationsState();
  const { service } = createService({ sink, operationsState });

  const first = await service.emit(routeEvent());
  const second = await service.emit(routeEvent({ request_id: "telemetry-runtime-002" }));
  assert.equal(first.status, "dropped");
  assert.equal(second.status, "dropped");
  assert.equal(second.status === "dropped" ? second.alertReceipt : null, "already_active");
  assert.equal(operationsState.alerts.length, 1);

  sink.failProbes = true;
  assert.deepEqual(await service.recover({ requestId: "telemetry-recover-001" }), {
    status: "still_degraded",
    failureCode: "TELEMETRY_SINK_UNAVAILABLE",
  });
  assert.equal(operationsState.state.state, "degraded");

  sink.failProbes = false;
  assert.deepEqual(await service.recover({ requestId: "telemetry-recover-002" }), {
    status: "recovered",
    state: {
      component: "product_telemetry_sink",
      state: "healthy",
      recordVersion: 3,
      transitionedAt: "2026-08-12T10:00:01.000Z",
      failureCode: null,
      alertOccurrenceId: "telemetry-alert-001",
    },
  });
  assert.equal(operationsState.state.state, "healthy");
});

test("operations-state failure remains fail-open without exposing adapter details", async () => {
  const sink = new FakeTelemetrySink();
  sink.failWrites = true;
  const operationsState = new FakeTelemetryOperationsState();
  operationsState.failTransitions = true;
  const { service } = createService({ sink, operationsState });

  const result = await service.emit(routeEvent());
  assert.equal(result.status, "dropped");
  assert.equal(result.status === "dropped" ? result.degradedState : null, "unrecorded");
  assert.equal(JSON.stringify(result).includes("synthetic"), false);
});

test("an inconsistent Operations receipt stays fail-open and is not reported as recorded", async () => {
  const sink = new FakeTelemetrySink();
  sink.failWrites = true;
  const operationsState = {
    async markDegraded() {
      return {
        transition: "entered" as const,
        state: {
          component: "product_telemetry_sink" as const,
          state: "healthy" as const,
          recordVersion: 2,
          transitionedAt: TIMESTAMP,
          failureCode: null,
          alertOccurrenceId: null,
        },
        alert: null,
      };
    },
    async markHealthy() {
      return {
        transition: "already_healthy" as const,
        state: {
          component: "product_telemetry_sink" as const,
          state: "healthy" as const,
          recordVersion: 2,
          transitionedAt: TIMESTAMP,
          failureCode: null,
          alertOccurrenceId: null,
        },
      };
    },
  };
  const { service } = createService({ sink, operationsState });

  const result = await service.emit(routeEvent());
  assert.equal(result.status, "dropped");
  assert.equal(result.status === "dropped" ? result.degradedState : null, "unrecorded");
  assert.equal(result.status === "dropped" ? result.alertReceipt : null, "unrecorded");
});

test("invalid alert identity stays fail-open without manufacturing a degraded receipt", async () => {
  const sink = new FakeTelemetrySink();
  sink.failWrites = true;
  const operationsState = new FakeTelemetryOperationsState();
  const { service } = createService({
    sink,
    operationsState,
    createAlertOccurrenceId: () => "not a safe opaque id",
  });

  const result = await service.emit(routeEvent());
  assert.equal(result.status, "dropped");
  assert.equal(result.status === "dropped" ? result.degradedState : null, "unrecorded");
  assert.equal(result.status === "dropped" ? result.alert : null, null);
  assert.equal(operationsState.alerts.length, 0);
});

test("mandatory audit failure raises AUDIT_UNAVAILABLE before the mutation commits", async () => {
  const { service } = createService({});
  const transaction = new FakeMandatoryAuditTransaction();
  transaction.failAppends = true;
  let businessFactCommitted = false;

  const audit = buildAuditEvent({
    id: AUDIT_ID,
    organizationId: ORGANIZATION_ID,
    actorUserId: ACTOR_ID,
    actorKind: "user",
    eventType: "case.updated",
    eventVersion: 1,
    action: "update",
    resourceType: "ServiceCase",
    resourceId: CASE_ID,
    outcome: "succeeded",
    requestId: REQUEST_ID,
    occurredAt: TIMESTAMP,
    metadata: { status: "updated" },
  });

  await assert.rejects(
    service.appendMandatoryAudit({ transaction, event: audit }).then(() => {
      businessFactCommitted = true;
    }),
    (error: unknown) =>
      error instanceof MandatoryAuditUnavailableError && error.code === "AUDIT_UNAVAILABLE",
  );
  assert.equal(businessFactCommitted, false);
  assert.equal(transaction.appended.length, 0);
});

test("mandatory audit uses the caller transaction and does not send a telemetry substitute", async () => {
  const { service, sink } = createService({});
  const transaction = new FakeMandatoryAuditTransaction();
  const audit = buildAuditEvent({
    id: AUDIT_ID,
    organizationId: ORGANIZATION_ID,
    actorUserId: ACTOR_ID,
    actorKind: "user",
    eventType: "case.updated",
    eventVersion: 1,
    action: "update",
    resourceType: "ServiceCase",
    resourceId: CASE_ID,
    outcome: "succeeded",
    requestId: REQUEST_ID,
    occurredAt: TIMESTAMP,
    metadata: { status: "updated" },
  });

  await service.appendMandatoryAudit({ transaction, event: audit });
  assert.equal(transaction.appended.length, 1);
  assert.equal(sink.attempts.length, 0);
});
