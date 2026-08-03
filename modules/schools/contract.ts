import { createHash } from "node:crypto";

export const SCHOOL_IDENTITY_FIELDS = Object.freeze([
  "school_key",
  "school_name_zh",
  "school_name_en",
  "official_website",
] as const);

export type SchoolFieldClass = "identity" | "general";
export type SchoolOverlayStatus = "candidate" | "approved" | "disabled" | "rejected";
export type SchoolReviewRole = "founder" | "data_reviewer" | "advisor";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface SchoolBaseRecord {
  readonly organizationId: string;
  readonly schoolId: string;
  readonly snapshotId: string;
  readonly sourceSchoolKey: string;
  readonly fields: Readonly<Record<string, JsonValue>>;
}

export interface SchoolOverlayEvidence {
  readonly sourceUrl: string;
  readonly quote: string;
}

export interface SchoolOverlayChange {
  readonly fieldName: string;
  readonly fieldClass: SchoolFieldClass;
  readonly proposedValue: JsonValue;
  readonly baseValueSha256: string;
  readonly evidence: SchoolOverlayEvidence;
}

export interface SchoolOverlayRevision {
  readonly organizationId: string;
  readonly schoolId: string;
  readonly baseSnapshotId: string;
  readonly revisionId: string;
  readonly revisionNumber: number;
  readonly requestedBy: string;
  readonly reason: string;
  readonly changes: readonly SchoolOverlayChange[];
  readonly status: SchoolOverlayStatus;
  readonly createdAt: string;
  readonly approvedBy?: string;
  readonly approvedRole?: Exclude<SchoolReviewRole, "advisor">;
  readonly approvedAt?: string;
  readonly disabledBy?: string;
  readonly disabledAt?: string;
  readonly disableReason?: string;
}

export interface SchoolOverlayApprovalInput {
  readonly requestedBy: string;
  readonly reviewerId: string;
  readonly reviewerRole: SchoolReviewRole;
  readonly fieldClasses: readonly SchoolFieldClass[];
}

export interface SchoolOverlayDisableInput {
  readonly disabledBy: string;
  readonly reason: string;
  readonly disabledAt: string;
}

export type SchoolDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code: string };

export interface SchoolResolutionProvenance {
  readonly sourceKind: "crawler_snapshot" | "approved_overlay";
  readonly sourceSnapshotId: string;
  readonly sourceSchoolKey: string;
  readonly overlayRevisionId?: string;
  readonly baseValueSha256?: string;
  readonly valueSha256: string;
}

export interface SchoolResolutionConflict {
  readonly fieldName: string;
  readonly kind: "base_changed";
  readonly previousBaseValueSha256: string;
  readonly currentBaseValueSha256: string;
}

export class SchoolContractError extends Error {
  readonly code: string;

  constructor(code: string, message = code) {
    super(message);
    this.name = "SchoolContractError";
    this.code = code;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalValue(value: unknown, ancestors = new Set<object>()): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new SchoolContractError("SCHOOL_VALUE_NOT_JSON");
    return value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new SchoolContractError("SCHOOL_VALUE_NOT_JSON");
    ancestors.add(value);
    const result = value.map((item) => canonicalValue(item, ancestors));
    ancestors.delete(value);
    return result;
  }
  if (!isPlainObject(value)) throw new SchoolContractError("SCHOOL_VALUE_NOT_JSON");
  if (ancestors.has(value)) throw new SchoolContractError("SCHOOL_VALUE_NOT_JSON");
  ancestors.add(value);

  const result = Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalValue(value[key], ancestors)]),
  );
  ancestors.delete(value);
  return result;
}

function canonicalJson(value: unknown): string {
  const normalized = canonicalValue(value);
  const encoded = JSON.stringify(normalized);
  if (encoded === undefined) throw new SchoolContractError("SCHOOL_VALUE_NOT_JSON");
  return encoded;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function nonBlank(value: string, code: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new SchoolContractError(code);
  return value.trim();
}

function validSha256(value: string, code: string): string {
  const normalized = nonBlank(value, code).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) throw new SchoolContractError(code);
  return normalized;
}

function validEvidence(evidence: SchoolOverlayEvidence): SchoolOverlayEvidence {
  const sourceUrl = nonBlank(evidence.sourceUrl, "SCHOOL_OVERLAY_EVIDENCE_URL_REQUIRED");
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(sourceUrl);
  } catch {
    throw new SchoolContractError("SCHOOL_OVERLAY_EVIDENCE_URL_INVALID");
  }
  if (parsedUrl.protocol !== "https:") {
    throw new SchoolContractError("SCHOOL_OVERLAY_EVIDENCE_URL_INVALID");
  }
  return deepFreeze({
    sourceUrl,
    quote: nonBlank(evidence.quote, "SCHOOL_OVERLAY_EVIDENCE_QUOTE_REQUIRED"),
  });
}

function validChange(change: SchoolOverlayChange): SchoolOverlayChange {
  const fieldName = nonBlank(change.fieldName, "SCHOOL_OVERLAY_FIELD_REQUIRED");
  if (
    (SCHOOL_IDENTITY_FIELDS as readonly string[]).includes(fieldName) &&
    change.fieldClass !== "identity"
  ) {
    throw new SchoolContractError("SCHOOL_IDENTITY_FIELD_CLASS_REQUIRED");
  }
  if (change.fieldClass !== "identity" && change.fieldClass !== "general") {
    throw new SchoolContractError("SCHOOL_OVERLAY_FIELD_CLASS_INVALID");
  }
  return deepFreeze({
    fieldName,
    fieldClass: change.fieldClass,
    proposedValue: canonicalValue(change.proposedValue),
    baseValueSha256: validSha256(
      change.baseValueSha256,
      "SCHOOL_OVERLAY_BASE_HASH_INVALID",
    ),
    evidence: validEvidence(change.evidence),
  });
}

export function sha256SchoolValue(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function canonicalSchoolValue(value: unknown): JsonValue {
  return canonicalValue(value);
}

export function schoolValuesEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export function proposeSchoolOverlay(input: {
  readonly organizationId: string;
  readonly schoolId: string;
  readonly baseSnapshotId: string;
  readonly revisionId: string;
  readonly revisionNumber: number;
  readonly requestedBy: string;
  readonly reason: string;
  readonly changes: readonly SchoolOverlayChange[];
  readonly createdAt: string;
}): SchoolOverlayRevision {
  if (!Number.isSafeInteger(input.revisionNumber) || input.revisionNumber < 1) {
    throw new SchoolContractError("SCHOOL_OVERLAY_REVISION_INVALID");
  }
  if (input.changes.length === 0) throw new SchoolContractError("SCHOOL_OVERLAY_FIELDS_REQUIRED");

  const changes = input.changes.map(validChange);
  const fieldNames = new Set<string>();
  for (const change of changes) {
    if (fieldNames.has(change.fieldName)) {
      throw new SchoolContractError("SCHOOL_OVERLAY_FIELD_DUPLICATE");
    }
    fieldNames.add(change.fieldName);
  }

  return deepFreeze({
    organizationId: nonBlank(input.organizationId, "SCHOOL_ORGANIZATION_REQUIRED"),
    schoolId: nonBlank(input.schoolId, "SCHOOL_ID_REQUIRED"),
    baseSnapshotId: nonBlank(input.baseSnapshotId, "SCHOOL_SNAPSHOT_REQUIRED"),
    revisionId: nonBlank(input.revisionId, "SCHOOL_OVERLAY_REVISION_ID_REQUIRED"),
    revisionNumber: input.revisionNumber,
    requestedBy: nonBlank(input.requestedBy, "SCHOOL_REQUESTER_REQUIRED"),
    reason: nonBlank(input.reason, "SCHOOL_OVERLAY_REASON_REQUIRED"),
    changes: Object.freeze(changes),
    status: "candidate",
    createdAt: nonBlank(input.createdAt, "SCHOOL_OVERLAY_CREATED_AT_REQUIRED"),
  });
}

export function evaluateSchoolOverlayApproval(input: SchoolOverlayApprovalInput): SchoolDecision {
  if (input.requestedBy === input.reviewerId) {
    return { allowed: false, code: "SCHOOL_REVIEWER_SELF_REVIEW_DENIED" };
  }
  if (input.reviewerRole !== "founder" && input.reviewerRole !== "data_reviewer") {
    return { allowed: false, code: "SCHOOL_REVIEWER_ROLE_NOT_ALLOWED" };
  }
  if (input.fieldClasses.includes("identity") && input.reviewerRole !== "founder") {
    return { allowed: false, code: "SCHOOL_IDENTITY_CHANGE_REQUIRES_FOUNDER" };
  }
  if (input.fieldClasses.length === 0) {
    return { allowed: false, code: "SCHOOL_OVERLAY_FIELDS_REQUIRED" };
  }
  return { allowed: true };
}

export function approveSchoolOverlay(
  revision: SchoolOverlayRevision,
  input: {
    readonly reviewerId: string;
    readonly reviewerRole: Exclude<SchoolReviewRole, "advisor">;
    readonly approvedAt: string;
  },
): SchoolOverlayRevision {
  if (revision.status !== "candidate") {
    throw new SchoolContractError("SCHOOL_OVERLAY_STATUS_TRANSITION_INVALID");
  }
  const decision = evaluateSchoolOverlayApproval({
    requestedBy: revision.requestedBy,
    reviewerId: input.reviewerId,
    reviewerRole: input.reviewerRole,
    fieldClasses: revision.changes.map((change) => change.fieldClass),
  });
  if (!decision.allowed) throw new SchoolContractError(decision.code);

  return deepFreeze({
    ...revision,
    status: "approved",
    approvedBy: nonBlank(input.reviewerId, "SCHOOL_REVIEWER_REQUIRED"),
    approvedRole: input.reviewerRole,
    approvedAt: nonBlank(input.approvedAt, "SCHOOL_OVERLAY_APPROVED_AT_REQUIRED"),
  });
}

export function disableSchoolOverlay(
  revision: SchoolOverlayRevision,
  input: SchoolOverlayDisableInput,
): SchoolOverlayRevision {
  if (revision.status !== "approved") {
    throw new SchoolContractError("SCHOOL_OVERLAY_STATUS_TRANSITION_INVALID");
  }
  if (revision.requestedBy === input.disabledBy) {
    throw new SchoolContractError("SCHOOL_REVIEWER_SELF_REVIEW_DENIED");
  }
  return deepFreeze({
    ...revision,
    status: "disabled",
    disabledBy: nonBlank(input.disabledBy, "SCHOOL_REVIEWER_REQUIRED"),
    disabledAt: nonBlank(input.disabledAt, "SCHOOL_OVERLAY_DISABLED_AT_REQUIRED"),
    disableReason: nonBlank(input.reason, "SCHOOL_OVERLAY_REASON_REQUIRED"),
  });
}
