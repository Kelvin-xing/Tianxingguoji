import type { AuditEvent } from "../../modules/audit/contract.ts";
import type { ProductTelemetryEvent } from "../../modules/operations/telemetry-contract.ts";
import type { AlertOccurrence } from "../../modules/operations/alert-catalogue.ts";
import {
  TELEMETRY_OPERATIONS_COMPONENT,
  type MandatoryAuditTransaction,
  type ProductTelemetrySinkAdapter,
  type TelemetryDegradedTransition,
  type TelemetryHealthyTransition,
  type TelemetryOperationsState,
  type TelemetryOperationsStateAdapter,
} from "../../modules/operations/telemetry-service.ts";

const INITIAL_TIMESTAMP = "2026-08-12T00:00:00.000Z";

export class FakeTelemetrySink implements ProductTelemetrySinkAdapter {
  readonly attempts: ProductTelemetryEvent[] = [];
  readonly delivered: ProductTelemetryEvent[] = [];
  failWrites = false;
  failProbes = false;

  async write(event: ProductTelemetryEvent): Promise<void> {
    this.attempts.push(event);
    if (this.failWrites) throw new Error("synthetic telemetry sink failure");
    this.delivered.push(event);
  }

  async probe(): Promise<void> {
    if (this.failProbes) throw new Error("synthetic telemetry probe failure");
  }
}

export class FakeTelemetryOperationsState implements TelemetryOperationsStateAdapter {
  state: TelemetryOperationsState = {
    component: TELEMETRY_OPERATIONS_COMPONENT,
    state: "healthy",
    recordVersion: 1,
    transitionedAt: INITIAL_TIMESTAMP,
    failureCode: null,
    alertOccurrenceId: null,
  };
  readonly alerts: AlertOccurrence[] = [];
  failTransitions = false;

  async markDegraded(input: {
    readonly requestId: string;
    readonly organizationId: string | null;
    readonly detectedAt: string;
    readonly alert: AlertOccurrence;
  }): Promise<TelemetryDegradedTransition> {
    void input.requestId;
    void input.organizationId;
    if (this.failTransitions) throw new Error("synthetic Operations state failure");
    if (this.state.state === "degraded") {
      return {
        transition: "already_degraded",
        state: this.state,
        alert: null,
      };
    }

    this.state = {
      component: TELEMETRY_OPERATIONS_COMPONENT,
      state: "degraded",
      recordVersion: this.state.recordVersion + 1,
      transitionedAt: input.detectedAt,
      failureCode: "TELEMETRY_SINK_UNAVAILABLE",
      alertOccurrenceId: input.alert.occurrence_id,
    };
    this.alerts.push(input.alert);
    return {
      transition: "entered",
      state: this.state,
      alert: input.alert,
    };
  }

  async markHealthy(input: {
    readonly requestId: string;
    readonly recoveredAt: string;
  }): Promise<TelemetryHealthyTransition> {
    void input.requestId;
    if (this.failTransitions) throw new Error("synthetic Operations state failure");
    if (this.state.state === "healthy") {
      return { transition: "already_healthy", state: this.state };
    }

    this.state = {
      component: TELEMETRY_OPERATIONS_COMPONENT,
      state: "healthy",
      recordVersion: this.state.recordVersion + 1,
      transitionedAt: input.recoveredAt,
      failureCode: null,
      alertOccurrenceId: this.state.alertOccurrenceId,
    };
    return { transition: "recovered", state: this.state };
  }
}

export class FakeMandatoryAuditTransaction implements MandatoryAuditTransaction {
  readonly appended: AuditEvent[] = [];
  failAppends = false;

  async append(event: AuditEvent): Promise<void> {
    if (this.failAppends) throw new Error("synthetic mandatory audit failure");
    this.appended.push(event);
  }
}
