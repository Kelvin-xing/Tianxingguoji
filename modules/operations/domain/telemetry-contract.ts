import type { OrganizationRole } from "../../access/public.ts";

export const TELEMETRY_SCHEMA_VERSION = "product_telemetry_v1" as const;
export const TELEMETRY_POLICY_VERSION = "hk_privacy_telemetry_v1" as const;
export const TELEMETRY_EVENT_NAMES = Object.freeze([
  "product.route.completed.v1",
  "product.command.completed.v1",
  "product.job.completed.v1",
] as const);

export type ProductTelemetryEventName = (typeof TELEMETRY_EVENT_NAMES)[number];
export type ProductTelemetryCategory = "route" | "command" | "job";
export type ProductTelemetryResult = "succeeded" | "denied" | "failed";
export type ProductTelemetryActorRole = OrganizationRole | "system";

export const TELEMETRY_FIELD_NAMES = Object.freeze([
  "event_name",
  "event_version",
  "schema_version",
  "policy_version",
  "occurred_at",
  "organization_id",
  "actor_id",
  "actor_role",
  "request_id",
  "session_id",
  "case_id",
  "job_id",
  "route_template",
  "result_code",
  "error_code",
  "retryable",
  "duration_ms",
  "build_version",
] as const);

export type ProductTelemetryFieldName = (typeof TELEMETRY_FIELD_NAMES)[number];

export type ProductTelemetryEvent = Readonly<{
  readonly event_name: ProductTelemetryEventName;
  readonly event_version: 1;
  readonly schema_version: typeof TELEMETRY_SCHEMA_VERSION;
  readonly policy_version: typeof TELEMETRY_POLICY_VERSION;
  readonly occurred_at: string;
  readonly organization_id: string | null;
  readonly actor_id: string | null;
  readonly actor_role: ProductTelemetryActorRole | null;
  readonly request_id: string;
  readonly session_id: string | null;
  readonly case_id: string | null;
  readonly job_id: string | null;
  readonly route_template: string | null;
  readonly result_code: ProductTelemetryResult;
  readonly error_code: string | null;
  readonly retryable: boolean;
  readonly duration_ms: number;
  readonly build_version: string;
}>;

export type ProductTelemetryPolicyErrorCode =
  | "TELEMETRY_EVENT_NOT_ALLOWED"
  | "TELEMETRY_SCHEMA_VERSION_UNSUPPORTED"
  | "TELEMETRY_POLICY_VERSION_UNSUPPORTED"
  | "TELEMETRY_FIELD_NOT_ALLOWED"
  | "PII_POLICY_REJECTED"
  | "TELEMETRY_VALUE_INVALID"
  | "TELEMETRY_CONTEXT_INVALID";

export class ProductTelemetryPolicyError extends Error {
  readonly code: ProductTelemetryPolicyErrorCode;

  constructor(code: ProductTelemetryPolicyErrorCode) {
    super(code);
    this.name = "ProductTelemetryPolicyError";
    this.code = code;
  }
}
