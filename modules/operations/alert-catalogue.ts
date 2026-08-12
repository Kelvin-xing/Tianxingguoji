export const ALERT_CATALOGUE_VERSION = "alert_catalogue_v1" as const;

export const ALERT_SEVERITIES = Object.freeze(["warning", "high", "critical"] as const);
export const ALERT_STATES = Object.freeze([
  "firing",
  "acknowledged",
  "mitigated",
  "closed",
  "needs_human",
] as const);

export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];
export type AlertState = (typeof ALERT_STATES)[number];
export type AlertEscalation = "business_hours" | "immediate_security" | "hk_region_incident";

export interface AlertDetector {
  readonly metricName: string;
  readonly comparator: "gte" | "eq";
  readonly threshold: number;
  readonly windowSeconds: number;
}

export interface AlertBudgetLevel {
  readonly percent: 50 | 80 | 100;
  readonly severity: AlertSeverity;
  readonly stopState: string;
}

export interface AlertDefinition {
  readonly alertId: string;
  readonly catalogueVersion: typeof ALERT_CATALOGUE_VERSION;
  readonly detector: AlertDetector;
  readonly severity: AlertSeverity;
  readonly owner: string;
  readonly backupOwner: string;
  readonly escalation: AlertEscalation;
  readonly deduplication: {
    readonly dimension: string;
    readonly cooldownSeconds: number;
  };
  readonly runbook: `docs/runbooks/${"auth" | "scan" | "outbox" | "pii" | "region" | "telemetry"}.md`;
  readonly stopState: string;
  readonly monthlyLimitUsd?: number;
  readonly budgetLevels?: readonly AlertBudgetLevel[];
}

export type AlertCatalogueErrorCode =
  | "ALERT_UNKNOWN_DEFINITION"
  | "ALERT_UNSUPPORTED_VERSION"
  | "ALERT_PAYLOAD_FIELD_NOT_ALLOWED"
  | "ALERT_PAYLOAD_INVALID"
  | "ALERT_THRESHOLD_NOT_MET";

export class AlertCatalogueError extends Error {
  readonly code: AlertCatalogueErrorCode;

  constructor(code: AlertCatalogueErrorCode) {
    super(code);
    this.name = "AlertCatalogueError";
    this.code = code;
  }
}

const budgetLevels = deepFreeze([
  { percent: 50, severity: "warning", stopState: "continue_monitoring" },
  { percent: 80, severity: "high", stopState: "founder_review_required" },
  { percent: 100, severity: "critical", stopState: "pause_nonessential_work" },
] as const);

export const ALERT_CATALOGUE: readonly AlertDefinition[] = deepFreeze([
  definition("auth.failure_burst", "authentication_failure_count", 10, 300, {
    severity: "warning",
    owner: "identity_operations",
    backupOwner: "security_owner",
    escalation: "business_hours",
    runbook: "docs/runbooks/auth.md",
    stopState: "authentication_review_required",
    cooldownSeconds: 300,
  }),
  definition("auth.revoke_backlog", "cognito_revoke_oldest_age_seconds", 600, 300, {
    severity: "high",
    owner: "identity_operations",
    backupOwner: "operations_owner",
    escalation: "business_hours",
    runbook: "docs/runbooks/auth.md",
    stopState: "local_denial_remains_authoritative",
    cooldownSeconds: 300,
  }),
  definition("scan.stuck", "document_scan_oldest_age_seconds", 180, 60, {
    severity: "high",
    owner: "document_operations",
    backupOwner: "operations_owner",
    escalation: "business_hours",
    runbook: "docs/runbooks/scan.md",
    stopState: "document_availability_fail_closed",
    cooldownSeconds: 300,
  }),
  definition("scan.dead_letter", "document_scan_dlq_count", 1, 60, {
    severity: "critical",
    owner: "document_operations",
    backupOwner: "security_owner",
    escalation: "business_hours",
    runbook: "docs/runbooks/scan.md",
    stopState: "scan_work_needs_human",
    cooldownSeconds: 300,
  }),
  definition("outbox.stuck", "outbox_oldest_pending_age_seconds", 300, 60, {
    severity: "high",
    owner: "notification_operations",
    backupOwner: "operations_owner",
    escalation: "business_hours",
    runbook: "docs/runbooks/outbox.md",
    stopState: "effect_delivery_needs_human",
    cooldownSeconds: 300,
  }),
  definition("privacy.pii_canary", "pii_canary_raw_match_count", 1, 60, {
    severity: "critical",
    owner: "privacy_owner",
    backupOwner: "security_owner",
    escalation: "immediate_security",
    runbook: "docs/runbooks/pii.md",
    stopState: "affected_telemetry_path_fail_closed",
    cooldownSeconds: 60,
  }),
  definition("telemetry.sink_degraded", "telemetry_sink_degraded_count", 1, 60, {
    severity: "high",
    owner: "operations_owner",
    backupOwner: "privacy_owner",
    escalation: "business_hours",
    runbook: "docs/runbooks/telemetry.md",
    stopState: "product_telemetry_degraded",
    cooldownSeconds: 300,
  }),
  definition("region.hk_unhealthy", "hk_region_consecutive_failed_checks", 2, 120, {
    severity: "critical",
    owner: "operations_owner",
    backupOwner: "founder",
    escalation: "hk_region_incident",
    runbook: "docs/runbooks/region.md",
    stopState: "hk_sensitive_operations_fail_closed",
    cooldownSeconds: 120,
  }),
  definition("dashboard.projection_mismatch", "dashboard_projection_hash_mismatch_count", 1, 60, {
    severity: "high",
    owner: "operations_owner",
    backupOwner: "case_workflow_owner",
    escalation: "business_hours",
    runbook: "docs/runbooks/outbox.md",
    stopState: "projection_marked_stale",
    cooldownSeconds: 300,
  }),
  budgetDefinition("budget.rds_monthly", "rds_monthly_budget_percent", 150),
  budgetDefinition("budget.s3_monthly", "s3_monthly_budget_percent", 25),
  budgetDefinition("budget.runtime_logging_monthly", "runtime_logging_monthly_budget_percent", 300),
]);

const definitionsById = new Map(ALERT_CATALOGUE.map((entry) => [entry.alertId, entry]));

export interface BuildAlertOccurrenceInput {
  readonly alertId: string;
  readonly catalogueVersion: string;
  readonly occurrenceId: string;
  readonly requestId: string;
  readonly organizationId: string | null;
  readonly detectedAt: string;
  readonly observedValue: number;
  readonly state: AlertState;
}

export interface AlertOccurrence {
  readonly alert_id: string;
  readonly catalogue_version: typeof ALERT_CATALOGUE_VERSION;
  readonly occurrence_id: string;
  readonly request_id: string;
  readonly organization_id: string | null;
  readonly detected_at: string;
  readonly metric_name: string;
  readonly observed_value: number;
  readonly threshold_value: number;
  readonly window_seconds: number;
  readonly severity: AlertSeverity;
  readonly state: AlertState;
}

export function getAlertDefinition(alertId: string, catalogueVersion: string): AlertDefinition {
  if (catalogueVersion !== ALERT_CATALOGUE_VERSION) {
    throw new AlertCatalogueError("ALERT_UNSUPPORTED_VERSION");
  }
  const definition = definitionsById.get(alertId);
  if (definition === undefined) throw new AlertCatalogueError("ALERT_UNKNOWN_DEFINITION");
  return definition;
}

export function buildAlertOccurrence(input: BuildAlertOccurrenceInput): AlertOccurrence {
  rejectUnknownFields(input as unknown as Record<string, unknown>);
  const definition = getAlertDefinition(input.alertId, input.catalogueVersion);
  requireSafeOpaqueId(input.occurrenceId);
  requireSafeOpaqueId(input.requestId);
  if (input.organizationId !== null && !UUID_PATTERN.test(input.organizationId)) invalidPayload();
  if (typeof input.detectedAt !== "string" || !Number.isFinite(Date.parse(input.detectedAt))) {
    invalidPayload();
  }
  if (!Number.isFinite(input.observedValue) || !ALERT_STATES.includes(input.state)) invalidPayload();

  const budgetLevel = resolveBudgetLevel(definition, input.observedValue);
  const threshold = budgetLevel?.percent ?? definition.detector.threshold;
  if (!meetsThreshold(definition.detector.comparator, input.observedValue, threshold)) {
    throw new AlertCatalogueError("ALERT_THRESHOLD_NOT_MET");
  }

  return deepFreeze({
    alert_id: definition.alertId,
    catalogue_version: definition.catalogueVersion,
    occurrence_id: input.occurrenceId,
    request_id: input.requestId,
    organization_id: input.organizationId,
    detected_at: new Date(input.detectedAt).toISOString(),
    metric_name: definition.detector.metricName,
    observed_value: input.observedValue,
    threshold_value: threshold,
    window_seconds: definition.detector.windowSeconds,
    severity: budgetLevel?.severity ?? definition.severity,
    state: input.state,
  });
}

export function isAlertStateTransitionAllowed(from: AlertState, to: AlertState): boolean {
  const transitions: Readonly<Record<AlertState, readonly AlertState[]>> = {
    firing: ["acknowledged", "needs_human"],
    acknowledged: ["mitigated", "needs_human"],
    mitigated: ["closed", "needs_human"],
    closed: [],
    needs_human: ["acknowledged", "mitigated"],
  };
  return transitions[from].includes(to);
}

function definition(
  alertId: string,
  metricName: string,
  threshold: number,
  windowSeconds: number,
  operational: {
    readonly severity: AlertSeverity;
    readonly owner: string;
    readonly backupOwner: string;
    readonly escalation: AlertEscalation;
    readonly runbook: AlertDefinition["runbook"];
    readonly stopState: string;
    readonly cooldownSeconds: number;
  },
): AlertDefinition {
  return {
    alertId,
    catalogueVersion: ALERT_CATALOGUE_VERSION,
    detector: { metricName, comparator: "gte", threshold, windowSeconds },
    severity: operational.severity,
    owner: operational.owner,
    backupOwner: operational.backupOwner,
    escalation: operational.escalation,
    deduplication: {
      dimension: "alert_id+organization_id",
      cooldownSeconds: operational.cooldownSeconds,
    },
    runbook: operational.runbook,
    stopState: operational.stopState,
  };
}

function budgetDefinition(alertId: string, metricName: string, monthlyLimitUsd: number): AlertDefinition {
  return {
    ...definition(alertId, metricName, 50, 86_400, {
      severity: "warning",
      owner: "operations_owner",
      backupOwner: "founder",
      escalation: "business_hours",
      runbook: "docs/runbooks/region.md",
      stopState: "continue_monitoring",
      cooldownSeconds: 86_400,
    }),
    monthlyLimitUsd,
    budgetLevels,
  };
}

function resolveBudgetLevel(
  definition: AlertDefinition,
  observedValue: number,
): AlertBudgetLevel | undefined {
  return definition.budgetLevels
    ?.filter((level) => observedValue >= level.percent)
    .at(-1);
}

function meetsThreshold(comparator: AlertDetector["comparator"], observed: number, threshold: number) {
  return comparator === "gte" ? observed >= threshold : observed === threshold;
}

const ALLOWED_OCCURRENCE_INPUT_FIELDS = new Set([
  "alertId",
  "catalogueVersion",
  "occurrenceId",
  "requestId",
  "organizationId",
  "detectedAt",
  "observedValue",
  "state",
]);
const SAFE_OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function rejectUnknownFields(input: Record<string, unknown>): void {
  if (input === null || typeof input !== "object" || Array.isArray(input)) invalidPayload();
  for (const field of Object.keys(input)) {
    if (!ALLOWED_OCCURRENCE_INPUT_FIELDS.has(field)) {
      throw new AlertCatalogueError("ALERT_PAYLOAD_FIELD_NOT_ALLOWED");
    }
  }
}

function requireSafeOpaqueId(value: string): void {
  if (typeof value !== "string" || !SAFE_OPAQUE_ID_PATTERN.test(value)) invalidPayload();
}

function invalidPayload(): never {
  throw new AlertCatalogueError("ALERT_PAYLOAD_INVALID");
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
