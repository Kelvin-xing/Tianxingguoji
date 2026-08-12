export const BILLING_TIME_ZONE = "Asia/Hong_Kong" as const;
export const ADVANCING_CASE_COUNT_POLICY_VERSION = "advancing_case_count_v1" as const;

export const BILLING_CASE_STAGES = Object.freeze([
  "signed",
  "background_collection",
  "school_selection_confirmed",
  "interview_preparation",
  "application_submitted",
  "awaiting_result",
  "offer_confirmed",
  "closed",
  "pending_delete",
] as const);

export const ADVANCING_CASE_STAGES = Object.freeze([
  "background_collection",
  "school_selection_confirmed",
  "interview_preparation",
  "application_submitted",
  "awaiting_result",
  "offer_confirmed",
] as const);

export type BillingCaseStage = (typeof BILLING_CASE_STAGES)[number];
export type AdvancingCaseStage = (typeof ADVANCING_CASE_STAGES)[number];

export const BILLING_CONTRACT_CURRENCIES = Object.freeze([
  "HKD",
  "USD",
  "CNY",
] as const);

export type BillingContractCurrency = (typeof BILLING_CONTRACT_CURRENCIES)[number];

export type BillingErrorCode =
  | "BILLING_COMMAND_DENIED"
  | "BILLING_CONTRACT_CURRENCY_INVALID"
  | "BILLING_CONTRACT_EFFECTIVE_PERIOD_OVERLAP"
  | "BILLING_CONTRACT_EFFECTIVE_RANGE_INVALID"
  | "BILLING_CONTRACT_VALUE_INVALID"
  | "BILLING_EVENT_CONTEXT_MISMATCH"
  | "BILLING_EVENT_CONFLICT"
  | "BILLING_EVENT_INCOMPLETE"
  | "BILLING_EVENT_PII_FORBIDDEN"
  | "BILLING_EVENT_STAGE_UNKNOWN"
  | "BILLING_EXPORT_DENIED"
  | "BILLING_MONTH_INVALID"
  | "BILLING_POLICY_UNAVAILABLE"
  | "BILLING_PROJECTION_INCOMPLETE"
  | "BILLING_RETENTION_PENDING"
  | "BILLING_SECOND_TENANT_UNAVAILABLE"
  | "BILLING_SELF_APPROVAL_DENIED"
  | "BILLING_SUBSCRIPTION_TRANSITION_UNAVAILABLE";

export class BillingContractError extends Error {
  readonly code: BillingErrorCode;

  constructor(code: BillingErrorCode, message = code) {
    super(message);
    this.name = "BillingContractError";
    this.code = code;
  }
}

export interface CaseLifecycleProjectionEvent {
  readonly eventId: string;
  readonly organizationId: string;
  readonly caseId: string;
  readonly stage: BillingCaseStage;
  readonly effectiveAt: string;
  readonly caseVersion: number;
}

export interface AdvancingCaseCountSnapshot {
  readonly organizationId: string;
  readonly billingMonth: string;
  readonly sourceCutoffAt: string;
  readonly countPolicyVersion: typeof ADVANCING_CASE_COUNT_POLICY_VERSION;
  readonly advancingCaseCount: number;
}

export interface CustomerContractVersion {
  readonly id: string;
  readonly organizationId: string;
  readonly contractNumber: string;
  readonly currency: BillingContractCurrency;
  /** Opaque approved source value; it has no fee, tax, or payable meaning. */
  readonly contractValueMinor: number;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly sourceReference: string;
  readonly createdByActorId: string;
  readonly approvedByActorId: string;
  readonly approvedAt: string;
  readonly recordVersion: number;
}

export interface ContractEffectivePeriod {
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
}

export type BillingContractDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code: BillingErrorCode };

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const BILLING_MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;
const EVENT_FIELDS = Object.freeze([
  "eventId",
  "organizationId",
  "caseId",
  "stage",
  "effectiveAt",
  "caseVersion",
] as const);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBillingCaseStage(value: unknown): value is BillingCaseStage {
  return (
    typeof value === "string" &&
    (BILLING_CASE_STAGES as readonly string[]).includes(value)
  );
}

function timestampMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : null;
}

export function resolveBillingMonthCutoff(billingMonth: string): string {
  const match = BILLING_MONTH_PATTERN.exec(billingMonth);
  if (match === null) throw new BillingContractError("BILLING_MONTH_INVALID");

  const year = Number(match[1]);
  const month = Number(match[2]);
  // Hong Kong is UTC+08:00 throughout the supported Gregorian calendar.
  return new Date(Date.UTC(year, month, 0, 15, 59, 59, 999)).toISOString();
}

export function parseCaseLifecycleProjectionEvent(
  value: unknown,
): CaseLifecycleProjectionEvent {
  if (!isRecord(value)) throw new BillingContractError("BILLING_EVENT_INCOMPLETE");

  const keys = Object.keys(value);
  if (keys.some((key) => !(EVENT_FIELDS as readonly string[]).includes(key))) {
    throw new BillingContractError("BILLING_EVENT_PII_FORBIDDEN");
  }
  if (!isBillingCaseStage(value.stage)) {
    if (typeof value.stage === "string") {
      throw new BillingContractError("BILLING_EVENT_STAGE_UNKNOWN");
    }
    throw new BillingContractError("BILLING_EVENT_INCOMPLETE");
  }
  if (
    typeof value.eventId !== "string" ||
    !EVENT_ID_PATTERN.test(value.eventId) ||
    typeof value.organizationId !== "string" ||
    !UUID_PATTERN.test(value.organizationId) ||
    typeof value.caseId !== "string" ||
    !UUID_PATTERN.test(value.caseId) ||
    timestampMs(value.effectiveAt) === null ||
    !Number.isSafeInteger(value.caseVersion) ||
    (value.caseVersion as number) < 1
  ) {
    throw new BillingContractError("BILLING_EVENT_INCOMPLETE");
  }

  return value as unknown as CaseLifecycleProjectionEvent;
}

export function createCustomerContractVersion(input: {
  readonly id: string;
  readonly organizationId: string;
  readonly contractNumber: string;
  readonly currency: string;
  readonly contractValueMinor: number;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly sourceReference: string;
  readonly createdByActorId: string;
  readonly approvedByActorId: string;
  readonly approvedAt: string;
  readonly recordVersion: number;
}): Readonly<CustomerContractVersion> {
  if (input.createdByActorId === input.approvedByActorId) {
    throw new BillingContractError("BILLING_SELF_APPROVAL_DENIED");
  }
  if (
    !Number.isSafeInteger(input.contractValueMinor) ||
    input.contractValueMinor < 0
  ) {
    throw new BillingContractError("BILLING_CONTRACT_VALUE_INVALID");
  }
  if (!(BILLING_CONTRACT_CURRENCIES as readonly string[]).includes(input.currency)) {
    throw new BillingContractError("BILLING_CONTRACT_CURRENCY_INVALID");
  }

  const effectiveFromMs = timestampMs(input.effectiveFrom);
  const effectiveToMs = input.effectiveTo === null ? null : timestampMs(input.effectiveTo);
  if (
    effectiveFromMs === null ||
    (input.effectiveTo !== null && effectiveToMs === null) ||
    (effectiveToMs !== null && effectiveToMs < effectiveFromMs)
  ) {
    throw new BillingContractError("BILLING_CONTRACT_EFFECTIVE_RANGE_INVALID");
  }
  if (
    !UUID_PATTERN.test(input.id) ||
    !UUID_PATTERN.test(input.organizationId) ||
    !UUID_PATTERN.test(input.createdByActorId) ||
    !UUID_PATTERN.test(input.approvedByActorId) ||
    input.contractNumber.trim() === "" ||
    input.sourceReference.trim() === "" ||
    timestampMs(input.approvedAt) === null ||
    !Number.isSafeInteger(input.recordVersion) ||
    input.recordVersion < 1
  ) {
    throw new BillingContractError("BILLING_COMMAND_DENIED");
  }

  return Object.freeze({
    ...input,
    currency: input.currency as BillingContractCurrency,
  });
}

export function evaluateContractEffectivePeriod(input: {
  readonly proposed: ContractEffectivePeriod;
  readonly existing: readonly ContractEffectivePeriod[];
}): BillingContractDecision {
  const proposedFromMs = timestampMs(input.proposed.effectiveFrom);
  const proposedToMs = input.proposed.effectiveTo === null
    ? Number.POSITIVE_INFINITY
    : timestampMs(input.proposed.effectiveTo);
  if (
    proposedFromMs === null ||
    proposedToMs === null ||
    proposedToMs < proposedFromMs
  ) {
    return { allowed: false, code: "BILLING_CONTRACT_EFFECTIVE_RANGE_INVALID" };
  }

  for (const current of input.existing) {
    const currentFromMs = timestampMs(current.effectiveFrom);
    const currentToMs = current.effectiveTo === null
      ? Number.POSITIVE_INFINITY
      : timestampMs(current.effectiveTo);
    if (
      currentFromMs === null ||
      currentToMs === null ||
      currentToMs < currentFromMs
    ) {
      return { allowed: false, code: "BILLING_CONTRACT_EFFECTIVE_RANGE_INVALID" };
    }
    if (proposedFromMs <= currentToMs && currentFromMs <= proposedToMs) {
      return { allowed: false, code: "BILLING_CONTRACT_EFFECTIVE_PERIOD_OVERLAP" };
    }
  }
  return { allowed: true };
}

export function buildAdvancingCaseCount(input: {
  readonly organizationId: string;
  readonly billingMonth: string;
  readonly projectionComplete: boolean;
  readonly events: readonly unknown[];
}): AdvancingCaseCountSnapshot {
  if (!input.projectionComplete) {
    throw new BillingContractError("BILLING_PROJECTION_INCOMPLETE");
  }
  if (!UUID_PATTERN.test(input.organizationId)) {
    throw new BillingContractError("BILLING_EVENT_CONTEXT_MISMATCH");
  }

  const sourceCutoffAt = resolveBillingMonthCutoff(input.billingMonth);
  const cutoffMs = Date.parse(sourceCutoffAt);
  const latestByCase = new Map<string, CaseLifecycleProjectionEvent>();
  const eventById = new Map<string, CaseLifecycleProjectionEvent>();
  const eventByCaseVersion = new Map<string, CaseLifecycleProjectionEvent>();

  for (const rawEvent of input.events) {
    const current = parseCaseLifecycleProjectionEvent(rawEvent);
    if (current.organizationId !== input.organizationId) {
      throw new BillingContractError("BILLING_EVENT_CONTEXT_MISMATCH");
    }
    const priorEvent = eventById.get(current.eventId);
    if (priorEvent !== undefined) {
      if (!sameProjectionEvent(priorEvent, current)) {
        throw new BillingContractError("BILLING_EVENT_CONFLICT");
      }
      continue;
    }
    eventById.set(current.eventId, current);

    const caseVersionKey = `${current.caseId}:${current.caseVersion}`;
    const priorCaseVersion = eventByCaseVersion.get(caseVersionKey);
    if (
      priorCaseVersion !== undefined &&
      !sameCaseVersionFacts(priorCaseVersion, current)
    ) {
      throw new BillingContractError("BILLING_EVENT_CONFLICT");
    }
    eventByCaseVersion.set(caseVersionKey, current);

    if (Date.parse(current.effectiveAt) > cutoffMs) continue;

    const previous = latestByCase.get(current.caseId);
    if (
      previous === undefined ||
      current.caseVersion > previous.caseVersion
    ) {
      latestByCase.set(current.caseId, current);
    }
  }

  let advancingCaseCount = 0;
  for (const current of latestByCase.values()) {
    if ((ADVANCING_CASE_STAGES as readonly BillingCaseStage[]).includes(current.stage)) {
      advancingCaseCount += 1;
    }
  }

  return {
    organizationId: input.organizationId,
    billingMonth: input.billingMonth,
    sourceCutoffAt,
    countPolicyVersion: ADVANCING_CASE_COUNT_POLICY_VERSION,
    advancingCaseCount,
  };
}

function sameProjectionEvent(
  left: CaseLifecycleProjectionEvent,
  right: CaseLifecycleProjectionEvent,
): boolean {
  return left.eventId === right.eventId && sameCaseVersionFacts(left, right);
}

function sameCaseVersionFacts(
  left: CaseLifecycleProjectionEvent,
  right: CaseLifecycleProjectionEvent,
): boolean {
  return (
    left.organizationId === right.organizationId &&
    left.caseId === right.caseId &&
    left.stage === right.stage &&
    left.effectiveAt === right.effectiveAt &&
    left.caseVersion === right.caseVersion
  );
}
