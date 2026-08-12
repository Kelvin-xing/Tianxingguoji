import { randomUUID } from "node:crypto";

import type { AuditEvent } from "../audit/contract.ts";
import {
  ALERT_CATALOGUE_VERSION,
  buildAlertOccurrence,
  type AlertOccurrence,
} from "./alert-catalogue.ts";
import {
  buildProductTelemetryEvent,
  type ProductTelemetryEvent,
} from "./telemetry-policy.ts";

export const TELEMETRY_DEGRADED_ALERT_ID = "telemetry.sink_degraded" as const;
export const TELEMETRY_SINK_FAILURE_CODE = "TELEMETRY_SINK_UNAVAILABLE" as const;
export const TELEMETRY_STATE_FAILURE_CODE = "TELEMETRY_STATE_UNAVAILABLE" as const;
export const TELEMETRY_OPERATIONS_COMPONENT = "product_telemetry_sink" as const;

export type TelemetrySinkFailureCode = typeof TELEMETRY_SINK_FAILURE_CODE;
export type TelemetryRuntimeState = "healthy" | "degraded";

export type TelemetryOperationsState = Readonly<{
  readonly component: typeof TELEMETRY_OPERATIONS_COMPONENT;
  readonly state: TelemetryRuntimeState;
  readonly recordVersion: number;
  readonly transitionedAt: string;
  readonly failureCode: TelemetrySinkFailureCode | null;
  readonly alertOccurrenceId: string | null;
}>;

export type TelemetryDegradedTransition = Readonly<{
  readonly transition: "entered" | "already_degraded";
  readonly state: TelemetryOperationsState;
  readonly alert: AlertOccurrence | null;
}>;

export type TelemetryHealthyTransition = Readonly<{
  readonly transition: "recovered" | "already_healthy";
  readonly state: TelemetryOperationsState;
}>;

/**
 * The production implementation is an HK sink adapter. It receives only the
 * already validated closed-schema event and never receives a business
 * command, request body, or raw provider error.
 */
export interface ProductTelemetrySinkAdapter {
  write(event: ProductTelemetryEvent): Promise<void>;
  probe(input: { readonly requestId: string }): Promise<void>;
}

/**
 * The Operations adapter owns an atomic state transition and alert receipt.
 * It must deduplicate concurrent degraded transitions rather than emitting a
 * new alert for every event that arrives during one outage.
 */
export interface TelemetryOperationsStateAdapter {
  markDegraded(input: {
    readonly requestId: string;
    readonly organizationId: string | null;
    readonly detectedAt: string;
    readonly alert: AlertOccurrence;
  }): Promise<TelemetryDegradedTransition>;
  markHealthy(input: {
    readonly requestId: string;
    readonly recoveredAt: string;
  }): Promise<TelemetryHealthyTransition>;
}

/**
 * This port must be bound to the owning business mutation transaction. The
 * telemetry service does not start, commit, or retry that transaction.
 */
export interface MandatoryAuditTransaction {
  append(event: AuditEvent): Promise<void>;
}

export type TelemetryEmissionResult = Readonly<
  | {
      readonly status: "delivered";
      readonly event: ProductTelemetryEvent;
    }
  | {
      readonly status: "dropped";
      readonly event: ProductTelemetryEvent;
      readonly failureCode: TelemetrySinkFailureCode;
      readonly degradedState: "recorded" | "unrecorded";
      readonly alert: AlertOccurrence | null;
      readonly alertReceipt: "created" | "already_active" | "unrecorded";
    }
>;

export type TelemetryRecoveryResult = Readonly<
  | {
      readonly status: "recovered";
      readonly state: TelemetryOperationsState;
    }
  | {
      readonly status: "still_degraded";
      readonly failureCode: TelemetrySinkFailureCode | typeof TELEMETRY_STATE_FAILURE_CODE;
    }
>;

export class MandatoryAuditUnavailableError extends Error {
  readonly code = "AUDIT_UNAVAILABLE" as const;

  constructor() {
    super("Mandatory audit could not be persisted.");
    this.name = "MandatoryAuditUnavailableError";
  }
}

export interface TelemetryServiceOptions {
  readonly sink: ProductTelemetrySinkAdapter;
  readonly operationsState: TelemetryOperationsStateAdapter;
  readonly now?: () => Date;
  readonly createAlertOccurrenceId?: () => string;
}

/**
 * Product telemetry is deliberately non-authoritative. A sink outage is
 * represented as a dropped event plus an Operations degraded transition; it
 * never causes the caller to replay its business command.
 */
export class ProductTelemetryService {
  private readonly sink: ProductTelemetrySinkAdapter;
  private readonly operationsState: TelemetryOperationsStateAdapter;
  private readonly now: () => Date;
  private readonly createAlertOccurrenceId: () => string;

  constructor(options: TelemetryServiceOptions) {
    this.sink = options.sink;
    this.operationsState = options.operationsState;
    this.now = options.now ?? (() => new Date());
    this.createAlertOccurrenceId = options.createAlertOccurrenceId ?? randomUUID;
  }

  async emit(input: unknown): Promise<TelemetryEmissionResult> {
    const event = buildProductTelemetryEvent(input);

    try {
      await this.sink.write(event);
      return Object.freeze({ status: "delivered", event });
    } catch {
      const alertContext = this.createDegradedAlert(event);
      if (!alertContext) return this.droppedWithoutReceipt(event);
      const { alert, detectedAt } = alertContext;

      try {
        const transition = await this.operationsState.markDegraded({
          requestId: event.request_id,
          organizationId: event.organization_id,
          detectedAt,
          alert,
        });
        assertDegradedTransition(transition, alert);
        return Object.freeze({
          status: "dropped",
          event,
          failureCode: TELEMETRY_SINK_FAILURE_CODE,
          degradedState: "recorded",
          alert,
          alertReceipt: transition.transition === "entered" ? "created" : "already_active",
        });
      } catch {
        // A telemetry-state outage must not turn a non-authoritative signal
        // into a business-mutation failure. The missing state receipt is
        // surfaced to the caller without exposing the adapter error.
        return Object.freeze({
          status: "dropped",
          event,
          failureCode: TELEMETRY_SINK_FAILURE_CODE,
          degradedState: "unrecorded",
          alert,
          alertReceipt: "unrecorded",
        });
      }
    }
  }

  async recover(input: { readonly requestId: string }): Promise<TelemetryRecoveryResult> {
    assertRequestId(input.requestId);

    try {
      await this.sink.probe({ requestId: input.requestId });
    } catch {
      return Object.freeze({
        status: "still_degraded",
        failureCode: TELEMETRY_SINK_FAILURE_CODE,
      });
    }

    try {
      const transition = await this.operationsState.markHealthy({
        requestId: input.requestId,
        recoveredAt: this.timestamp(),
      });
      assertHealthyTransition(transition);
      return Object.freeze({ status: "recovered", state: transition.state });
    } catch {
      return Object.freeze({
        status: "still_degraded",
        failureCode: TELEMETRY_STATE_FAILURE_CODE,
      });
    }
  }

  /**
   * Mandatory audit is a separate path from product telemetry. A repository
   * calls this before committing its mutation and rolls back when this typed
   * error is raised. No telemetry sink call is attempted as compensation.
   */
  async appendMandatoryAudit(input: {
    readonly transaction: MandatoryAuditTransaction;
    readonly event: AuditEvent;
  }): Promise<void> {
    try {
      await input.transaction.append(input.event);
    } catch {
      throw new MandatoryAuditUnavailableError();
    }
  }

  private timestamp(): string {
    const timestamp = this.now();
    if (!(timestamp instanceof Date) || !Number.isFinite(timestamp.getTime())) {
      throw new TypeError("Telemetry clock must return a valid Date.");
    }
    return timestamp.toISOString();
  }

  private createDegradedAlert(event: ProductTelemetryEvent):
    | { readonly alert: AlertOccurrence; readonly detectedAt: string }
    | null {
    try {
      const detectedAt = this.timestamp();
      const alert = buildAlertOccurrence({
        alertId: TELEMETRY_DEGRADED_ALERT_ID,
        catalogueVersion: ALERT_CATALOGUE_VERSION,
        occurrenceId: this.createAlertOccurrenceId(),
        requestId: event.request_id,
        organizationId: event.organization_id,
        detectedAt,
        observedValue: 1,
        state: "firing",
      });
      return { alert, detectedAt };
    } catch {
      return null;
    }
  }

  private droppedWithoutReceipt(event: ProductTelemetryEvent): TelemetryEmissionResult {
    return Object.freeze({
      status: "dropped",
      event,
      failureCode: TELEMETRY_SINK_FAILURE_CODE,
      degradedState: "unrecorded",
      alert: null,
      alertReceipt: "unrecorded",
    });
  }
}

function assertRequestId(value: string): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new TypeError("Telemetry recovery requires a safe request ID.");
  }
}

function assertDegradedTransition(
  transition: TelemetryDegradedTransition,
  alert: AlertOccurrence,
): void {
  if (
    transition.state.component !== TELEMETRY_OPERATIONS_COMPONENT ||
    transition.state.state !== "degraded" ||
    transition.state.failureCode !== TELEMETRY_SINK_FAILURE_CODE
  ) {
    throw new TypeError("Operations state adapter did not record degraded state.");
  }
  if (
    transition.transition === "entered" &&
    (transition.alert?.occurrence_id !== alert.occurrence_id ||
      transition.state.alertOccurrenceId !== alert.occurrence_id)
  ) {
    throw new TypeError("Operations state adapter returned an invalid alert receipt.");
  }
  if (
    transition.transition !== "entered" &&
    transition.transition !== "already_degraded"
  ) {
    throw new TypeError("Operations state adapter returned an invalid transition.");
  }
}

function assertHealthyTransition(transition: TelemetryHealthyTransition): void {
  if (
    transition.state.component !== TELEMETRY_OPERATIONS_COMPONENT ||
    transition.state.state !== "healthy" ||
    transition.state.failureCode !== null ||
    (transition.transition !== "recovered" && transition.transition !== "already_healthy")
  ) {
    throw new TypeError("Operations state adapter did not record healthy state.");
  }
}
