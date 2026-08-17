import {
  ProductTelemetryPolicyError,
  TELEMETRY_EVENT_NAMES,
  TELEMETRY_FIELD_NAMES,
  TELEMETRY_POLICY_VERSION,
  TELEMETRY_SCHEMA_VERSION,
  type ProductTelemetryEvent,
  type ProductTelemetryEventName,
  type ProductTelemetryActorRole,
} from "./telemetry-contract.ts";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ERROR_CODE = /^[A-Z][A-Z0-9_.:-]{0,127}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const ROUTE_TEMPLATE = /^\/api\/v1\/(?:[A-Za-z0-9._-]+|\[(?:[A-Za-z][A-Za-z0-9_]{0,63})\])(?:\/(?:[A-Za-z0-9._-]+|\[(?:[A-Za-z][A-Za-z0-9_]{0,63})\]))*$/;
const FORBIDDEN_KEY =
  /(?:student|guardian|email|phone|name|birth|dob|address|document|file|ocr|note|assessment|answer|message|body|content|token|secret|password|cookie|auth|header|presigned|query|form|input|free_text|keystroke|screen|dom|replay)/i;
const FORBIDDEN_VALUE = /(?:@|\+?\d[\d ()-]{7,}|https?:\/\/|Bearer\s|AKIA[0-9A-Z]{12,})/i;
const ALLOWED_ROLES = new Set<ProductTelemetryActorRole>([
  "founder",
  "admin",
  "advisor",
  "data_reviewer",
  "contractor",
  "system",
]);
const FIELD_SET = new Set<string>(TELEMETRY_FIELD_NAMES);

export function buildProductTelemetryEvent(input: unknown): ProductTelemetryEvent {
  const record = requirePlainRecord(input);
  rejectForbiddenKeys(record);

  const eventName = record.event_name;
  if (typeof eventName !== "string" || !TELEMETRY_EVENT_NAMES.includes(eventName as ProductTelemetryEventName)) {
    throw new ProductTelemetryPolicyError("TELEMETRY_EVENT_NOT_ALLOWED");
  }
  if (record.schema_version !== TELEMETRY_SCHEMA_VERSION) {
    throw new ProductTelemetryPolicyError("TELEMETRY_SCHEMA_VERSION_UNSUPPORTED");
  }
  if (record.policy_version !== TELEMETRY_POLICY_VERSION) {
    throw new ProductTelemetryPolicyError("TELEMETRY_POLICY_VERSION_UNSUPPORTED");
  }

  for (const key of Object.keys(record)) {
    if (!FIELD_SET.has(key)) throw new ProductTelemetryPolicyError("TELEMETRY_FIELD_NOT_ALLOWED");
  }

  const event = {
    event_name: eventName as ProductTelemetryEvent["event_name"],
    event_version: requireLiteralOne(record.event_version),
    schema_version: TELEMETRY_SCHEMA_VERSION,
    policy_version: TELEMETRY_POLICY_VERSION,
    occurred_at: requireUtc(record.occurred_at),
    organization_id: nullableUuid(record.organization_id),
    actor_id: nullableUuid(record.actor_id),
    actor_role: nullableRole(record.actor_role),
    request_id: requireRequestId(record.request_id),
    session_id: nullableUuid(record.session_id),
    case_id: nullableUuid(record.case_id),
    job_id: nullableUuid(record.job_id),
    route_template: nullableRoute(record.route_template),
    result_code: requireResult(record.result_code),
    error_code: nullableErrorCode(record.error_code),
    retryable: requireBoolean(record.retryable),
    duration_ms: requireDuration(record.duration_ms),
    build_version: requireToken(record.build_version),
  } satisfies ProductTelemetryEvent;

  if ((event.result_code === "succeeded") !== (event.error_code === null)) {
    throw new ProductTelemetryPolicyError("TELEMETRY_VALUE_INVALID");
  }
  validateContext(event);
  return Object.freeze(event);
}

function validateContext(event: ProductTelemetryEvent): void {
  const category = event.event_name.split(".")[1];
  if (category === "job") {
    if (!event.job_id || event.actor_id !== null || event.actor_role !== null || event.session_id !== null || event.route_template !== null) {
      throw new ProductTelemetryPolicyError("TELEMETRY_CONTEXT_INVALID");
    }
    return;
  }

  if (!event.organization_id || !event.actor_id || !event.actor_role || !event.session_id || !event.route_template || event.job_id !== null) {
    throw new ProductTelemetryPolicyError("TELEMETRY_CONTEXT_INVALID");
  }
  if (category === "route" && event.case_id !== null && !UUID.test(event.case_id)) {
    throw new ProductTelemetryPolicyError("TELEMETRY_CONTEXT_INVALID");
  }
}

function requirePlainRecord(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) {
    throw new ProductTelemetryPolicyError("TELEMETRY_VALUE_INVALID");
  }
  return input as Record<string, unknown>;
}

function rejectForbiddenKeys(record: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(record)) {
    if (FORBIDDEN_KEY.test(key) && !TELEMETRY_FIELD_NAMES.includes(key as never)) {
      throw new ProductTelemetryPolicyError("PII_POLICY_REJECTED");
    }
    if (
      typeof value === "string" &&
      !UUID.test(value) &&
      !ISO_UTC.test(value) &&
      !ROUTE_TEMPLATE.test(value) &&
      FORBIDDEN_VALUE.test(value)
    ) {
      throw new ProductTelemetryPolicyError("PII_POLICY_REJECTED");
    }
    if (value !== null && typeof value === "object") {
      throw new ProductTelemetryPolicyError("TELEMETRY_VALUE_INVALID");
    }
  }
}

function requireLiteralOne(value: unknown): 1 {
  if (value !== 1) throw new ProductTelemetryPolicyError("TELEMETRY_VALUE_INVALID");
  return 1;
}

function requireUtc(value: unknown): string {
  if (typeof value !== "string" || !ISO_UTC.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new ProductTelemetryPolicyError("TELEMETRY_VALUE_INVALID");
  }
  return value;
}

function requireRequestId(value: unknown): string {
  if (typeof value !== "string" || !SAFE_REQUEST_ID.test(value)) {
    throw new ProductTelemetryPolicyError("TELEMETRY_VALUE_INVALID");
  }
  return value;
}

function requireToken(value: unknown): string {
  if (typeof value !== "string" || !SAFE_TOKEN.test(value)) {
    throw new ProductTelemetryPolicyError("TELEMETRY_VALUE_INVALID");
  }
  return value;
}

function nullableUuid(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !UUID.test(value)) throw new ProductTelemetryPolicyError("TELEMETRY_VALUE_INVALID");
  return value;
}

function nullableRole(value: unknown): ProductTelemetryActorRole | null {
  if (value === null) return null;
  if (typeof value !== "string" || !ALLOWED_ROLES.has(value as ProductTelemetryActorRole)) {
    throw new ProductTelemetryPolicyError("TELEMETRY_VALUE_INVALID");
  }
  return value as ProductTelemetryActorRole;
}

function nullableRoute(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !ROUTE_TEMPLATE.test(value) || value.includes("?") || value.includes("#") || value.includes("%")) {
    throw new ProductTelemetryPolicyError("TELEMETRY_VALUE_INVALID");
  }
  return value;
}

function requireResult(value: unknown): ProductTelemetryEvent["result_code"] {
  if (value !== "succeeded" && value !== "denied" && value !== "failed") {
    throw new ProductTelemetryPolicyError("TELEMETRY_VALUE_INVALID");
  }
  return value;
}

function nullableErrorCode(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !ERROR_CODE.test(value)) throw new ProductTelemetryPolicyError("TELEMETRY_VALUE_INVALID");
  return value;
}

function requireBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new ProductTelemetryPolicyError("TELEMETRY_VALUE_INVALID");
  return value;
}

function requireDuration(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ProductTelemetryPolicyError("TELEMETRY_VALUE_INVALID");
  }
  return value;
}
