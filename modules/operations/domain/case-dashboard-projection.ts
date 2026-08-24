import { createHash } from "node:crypto";

import type {
  CollaboratorCapability,
  CollaboratorScope,
  OrganizationRole,
  ScopeGrantStatus,
} from "../../access/public.ts";
import { COLLABORATOR_CAPABILITIES, COLLABORATOR_SCOPES } from "../../access/public.ts";
import type { ServiceCaseStage } from "../../cases/public.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SOURCE_VERSION = "case_dashboard_source_v1" as const;
const PROJECTION_VERSION = "case_dashboard_projection_v1" as const;
const CASE_STAGES = new Set<ServiceCaseStage>([
  "signed",
  "background_collection",
  "school_selection_confirmed",
  "application_in_progress",
  "closed",
]);

export interface CaseDashboardProjectionSourceCase {
  readonly caseId: string;
  readonly organizationId: string;
  readonly caseNumber: string;
  readonly studentDisplayName: string;
  readonly stage: ServiceCaseStage;
  readonly blockerCount: number;
  readonly nextAction: string | null;
  readonly nextActionDueAtMs: number | null;
  readonly educationProfileCompleteness: number;
  readonly schoolTargetCount: number;
  readonly openTaskCount: number;
  readonly unreadCommunicationCount: number;
}

export interface CaseDashboardProjectionSource {
  readonly schemaVersion: typeof SOURCE_VERSION;
  readonly sourceSnapshotId: string;
  readonly sourceCapturedAtMs: number;
  readonly organizationId: string;
  readonly cases: readonly CaseDashboardProjectionSourceCase[];
}

export interface StoredCaseDashboardCase {
  readonly caseId: string;
  readonly caseNumber: string;
  readonly studentDisplayName: string;
  readonly stage: ServiceCaseStage;
  readonly blockerCount: number;
  readonly nextAction: string | null;
  readonly nextActionDueAtMs: number | null;
  readonly educationProfileCompleteness: number;
  readonly schoolTargetCount: number;
  readonly openTaskCount: number;
  readonly unreadCommunicationCount: number;
}

export interface StoredCaseDashboardProjection {
  readonly schemaVersion: typeof PROJECTION_VERSION;
  readonly sourceSchemaVersion: typeof SOURCE_VERSION;
  readonly sourceSnapshotId: string;
  readonly sourceCapturedAtMs: number;
  readonly organizationId: string;
  readonly cases: readonly StoredCaseDashboardCase[];
  readonly contentHash: string;
}

export interface CurrentDashboardGrant {
  readonly organizationId: string;
  readonly caseId: string;
  readonly scope: CollaboratorScope;
  readonly capability: CollaboratorCapability;
  readonly status: ScopeGrantStatus;
  readonly startsAtMs: number;
  readonly expiresAtMs: number;
}

export type DashboardAuthority =
  | { readonly kind: "founder" }
  | { readonly kind: "advisor"; readonly assignedCaseIds: readonly string[] }
  | { readonly kind: "collaborator"; readonly grants: readonly CurrentDashboardGrant[] }
  | { readonly kind: "denied" };

export interface CaseDashboardActor {
  readonly userId: string;
  readonly organizationId: string;
  readonly role: OrganizationRole;
}

export interface CaseDashboardProjectionRepositoryInput {
  readonly actorUserId: string;
  readonly organizationId: string;
  readonly nowMs: number;
}

export interface CaseDashboardProjectionTransactionResult {
  readonly projection: StoredCaseDashboardProjection;
  readonly authority: DashboardAuthority;
  readonly stale?: boolean;
}

export interface CaseDashboardProjectionRepository {
  /**
   * The HK RDS adapter must read the projection and current membership, role,
   * assignment, collaboration, grant, capability and expiry facts in one
   * read-only transaction. The projection is never an authorization source.
   */
  readDashboardTransaction(
    input: CaseDashboardProjectionRepositoryInput,
  ): Promise<CaseDashboardProjectionTransactionResult>;
}

export interface CaseDashboardResultCase {
  readonly case_id: string;
  readonly summary?: {
    readonly case_number: string;
    readonly student_display_name: string;
    readonly stage: ServiceCaseStage;
    readonly blocker_count: number;
    readonly next_action: string | null;
    readonly next_action_due_at_ms: number | null;
  };
  readonly education_profile?: { readonly completeness_percent: number };
  readonly school_targets?: { readonly count: number };
  readonly tasks?: { readonly open_count: number };
  readonly communications?: { readonly unread_count: number };
}

export interface CaseDashboardResult {
  readonly projection_version: typeof PROJECTION_VERSION;
  readonly source_snapshot_id: string;
  readonly source_captured_at_ms: number;
  readonly projection_hash: string;
  readonly stale: boolean;
  readonly cases: readonly CaseDashboardResultCase[];
}

export type CaseDashboardProjectionErrorCode =
  | "CASE_DASHBOARD_INVALID"
  | "CASE_DASHBOARD_FORBIDDEN"
  | "CASE_DASHBOARD_PROJECTION_INVALID";

export class CaseDashboardProjectionError extends Error {
  readonly code: CaseDashboardProjectionErrorCode;

  constructor(code: CaseDashboardProjectionErrorCode) {
    super(`Case dashboard rejected ${code}.`);
    this.name = "CaseDashboardProjectionError";
    this.code = code;
  }
}

export function buildCaseDashboardProjection(
  source: CaseDashboardProjectionSource,
): StoredCaseDashboardProjection {
  assertSource(source);
  const cases = source.cases
    .map<StoredCaseDashboardCase>((item) => Object.freeze({
      caseId: item.caseId,
      caseNumber: item.caseNumber,
      studentDisplayName: item.studentDisplayName,
      stage: item.stage,
      blockerCount: item.blockerCount,
      nextAction: item.nextAction,
      nextActionDueAtMs: item.nextActionDueAtMs,
      educationProfileCompleteness: item.educationProfileCompleteness,
      schoolTargetCount: item.schoolTargetCount,
      openTaskCount: item.openTaskCount,
      unreadCommunicationCount: item.unreadCommunicationCount,
    }))
    .sort((left, right) => left.caseId.localeCompare(right.caseId));

  const withoutHash = {
    schemaVersion: PROJECTION_VERSION,
    sourceSchemaVersion: SOURCE_VERSION,
    sourceSnapshotId: source.sourceSnapshotId,
    sourceCapturedAtMs: source.sourceCapturedAtMs,
    organizationId: source.organizationId,
    cases: Object.freeze(cases),
  } as const;

  return Object.freeze({
    ...withoutHash,
    contentHash: hashProjection(withoutHash),
  });
}

export function rebuildCaseDashboardProjection(
  source: CaseDashboardProjectionSource,
): StoredCaseDashboardProjection {
  return buildCaseDashboardProjection(source);
}

export class CaseDashboardProjectionService {
  private readonly repository: CaseDashboardProjectionRepository;
  private readonly nowMs: () => number;

  constructor(options: {
    readonly repository: CaseDashboardProjectionRepository;
    readonly nowMs?: () => number;
  }) {
    this.repository = options.repository;
    this.nowMs = options.nowMs ?? Date.now;
  }

  async getDashboard(input: { readonly actor: CaseDashboardActor }): Promise<CaseDashboardResult> {
    if (!UUID.test(input.actor.userId) || !UUID.test(input.actor.organizationId)) {
      throw new CaseDashboardProjectionError("CASE_DASHBOARD_INVALID");
    }
    if (input.actor.role !== "founder" && input.actor.role !== "advisor") {
      throw new CaseDashboardProjectionError("CASE_DASHBOARD_FORBIDDEN");
    }

    const nowMs = this.nowMs();
    if (!Number.isSafeInteger(nowMs) || nowMs <= 0) {
      throw new CaseDashboardProjectionError("CASE_DASHBOARD_PROJECTION_INVALID");
    }
    const transaction = await this.repository.readDashboardTransaction({
      actorUserId: input.actor.userId,
      organizationId: input.actor.organizationId,
      nowMs,
    });
    assertStoredProjection(transaction.projection, input.actor.organizationId);
    if (transaction.authority.kind === "denied") {
      throw new CaseDashboardProjectionError("CASE_DASHBOARD_FORBIDDEN");
    }

    return Object.freeze({
      projection_version: PROJECTION_VERSION,
      source_snapshot_id: transaction.projection.sourceSnapshotId,
      source_captured_at_ms: transaction.projection.sourceCapturedAtMs,
      projection_hash: transaction.projection.contentHash,
      stale: transaction.stale === true,
      cases: Object.freeze(shapeCases(
        transaction.projection.cases,
        transaction.authority,
        input.actor.organizationId,
        nowMs,
      )),
    });
  }
}

function shapeCases(
  cases: readonly StoredCaseDashboardCase[],
  authority: Exclude<DashboardAuthority, { readonly kind: "denied" }>,
  organizationId: string,
  nowMs: number,
): CaseDashboardResultCase[] {
  if (authority.kind === "founder") return cases.map((item) => shapeFullCase(item));
  if (authority.kind === "advisor") {
    const assigned = new Set(authority.assignedCaseIds.filter((caseId) => UUID.test(caseId)));
    return cases.filter((item) => assigned.has(item.caseId)).map((item) => shapeFullCase(item));
  }

  const scopesByCase = new Map<string, Set<CollaboratorScope>>();
  for (const grant of authority.grants) {
    if (
      grant.status !== "active" ||
      grant.organizationId !== organizationId ||
      grant.startsAtMs > nowMs ||
      grant.expiresAtMs <= nowMs ||
      !UUID.test(grant.caseId) ||
      !(COLLABORATOR_SCOPES as readonly string[]).includes(grant.scope) ||
      !(COLLABORATOR_CAPABILITIES as readonly string[]).includes(grant.capability)
    ) continue;
    const scopes = scopesByCase.get(grant.caseId) ?? new Set<CollaboratorScope>();
    scopes.add(grant.scope);
    scopesByCase.set(grant.caseId, scopes);
  }

  const result: CaseDashboardResultCase[] = [];
  for (const item of cases) {
    const scopes = scopesByCase.get(item.caseId);
    if (!scopes) continue;
    const shaped = shapeScopedCase(item, scopes);
    if (Object.keys(shaped).length > 1) result.push(shaped);
  }
  return result;
}

function shapeFullCase(item: StoredCaseDashboardCase): CaseDashboardResultCase {
  return Object.freeze({
    case_id: item.caseId,
    summary: summaryOf(item),
    education_profile: Object.freeze({ completeness_percent: item.educationProfileCompleteness }),
    school_targets: Object.freeze({ count: item.schoolTargetCount }),
    tasks: Object.freeze({ open_count: item.openTaskCount }),
    communications: Object.freeze({ unread_count: item.unreadCommunicationCount }),
  });
}

function shapeScopedCase(
  item: StoredCaseDashboardCase,
  scopes: ReadonlySet<CollaboratorScope>,
): CaseDashboardResultCase {
  return Object.freeze({
    case_id: item.caseId,
    ...(scopes.has("case_summary") ? { summary: summaryOf(item) } : {}),
    ...(scopes.has("education_profile")
      ? { education_profile: Object.freeze({ completeness_percent: item.educationProfileCompleteness }) }
      : {}),
    ...(scopes.has("school_targets")
      ? { school_targets: Object.freeze({ count: item.schoolTargetCount }) }
      : {}),
    ...(scopes.has("task_workspace")
      ? { tasks: Object.freeze({ open_count: item.openTaskCount }) }
      : {}),
    ...(scopes.has("communications")
      ? { communications: Object.freeze({ unread_count: item.unreadCommunicationCount }) }
      : {}),
  });
}

function summaryOf(item: StoredCaseDashboardCase) {
  return Object.freeze({
    case_number: item.caseNumber,
    student_display_name: item.studentDisplayName,
    stage: item.stage,
    blocker_count: item.blockerCount,
    next_action: item.nextAction,
    next_action_due_at_ms: item.nextActionDueAtMs,
  });
}

function assertSource(source: CaseDashboardProjectionSource): void {
  if (
    source.schemaVersion !== SOURCE_VERSION ||
    !UUID.test(source.organizationId) ||
    !isSafeLabel(source.sourceSnapshotId, 128) ||
    !isPositiveSafeInteger(source.sourceCapturedAtMs) ||
    !Array.isArray(source.cases)
  ) throw new CaseDashboardProjectionError("CASE_DASHBOARD_INVALID");

  const caseIds = new Set<string>();
  for (const item of source.cases) {
    if (
      !UUID.test(item.caseId) ||
      item.organizationId !== source.organizationId ||
      caseIds.has(item.caseId) ||
      !isSafeLabel(item.caseNumber, 80) ||
      !isSafeLabel(item.studentDisplayName, 200) ||
      !CASE_STAGES.has(item.stage) ||
      !isBoundedCount(item.blockerCount) ||
      !isBoundedCount(item.schoolTargetCount) ||
      !isBoundedCount(item.openTaskCount) ||
      !isBoundedCount(item.unreadCommunicationCount) ||
      !Number.isInteger(item.educationProfileCompleteness) ||
      item.educationProfileCompleteness < 0 ||
      item.educationProfileCompleteness > 100 ||
      (item.nextAction !== null && !isSafeLabel(item.nextAction, 300)) ||
      (item.nextActionDueAtMs !== null && !isPositiveSafeInteger(item.nextActionDueAtMs))
    ) throw new CaseDashboardProjectionError("CASE_DASHBOARD_INVALID");
    caseIds.add(item.caseId);
  }
}

function assertStoredProjection(
  projection: StoredCaseDashboardProjection,
  organizationId: string,
): void {
  if (
    projection.schemaVersion !== PROJECTION_VERSION ||
    projection.sourceSchemaVersion !== SOURCE_VERSION ||
    projection.organizationId !== organizationId ||
    !Array.isArray(projection.cases) ||
    !/^[a-f0-9]{64}$/.test(projection.contentHash)
  ) throw new CaseDashboardProjectionError("CASE_DASHBOARD_PROJECTION_INVALID");

  let previousCaseId = "";
  for (const item of projection.cases) {
    if (
      !hasExactKeys(item, [
        "caseId", "caseNumber", "studentDisplayName", "stage", "blockerCount",
        "nextAction", "nextActionDueAtMs", "educationProfileCompleteness",
        "schoolTargetCount", "openTaskCount", "unreadCommunicationCount",
      ]) ||
      !UUID.test(item.caseId) ||
      item.caseId <= previousCaseId ||
      !isSafeLabel(item.caseNumber, 80) ||
      !isSafeLabel(item.studentDisplayName, 200) ||
      !CASE_STAGES.has(item.stage) ||
      !isBoundedCount(item.blockerCount) ||
      !isBoundedCount(item.schoolTargetCount) ||
      !isBoundedCount(item.openTaskCount) ||
      !isBoundedCount(item.unreadCommunicationCount) ||
      !Number.isInteger(item.educationProfileCompleteness) ||
      item.educationProfileCompleteness < 0 ||
      item.educationProfileCompleteness > 100 ||
      (item.nextAction !== null && !isSafeLabel(item.nextAction, 300)) ||
      (item.nextActionDueAtMs !== null && !isPositiveSafeInteger(item.nextActionDueAtMs))
    ) throw new CaseDashboardProjectionError("CASE_DASHBOARD_PROJECTION_INVALID");
    previousCaseId = item.caseId;
  }

  const { contentHash, ...withoutHash } = projection;
  if (hashProjection(withoutHash) !== contentHash) {
    throw new CaseDashboardProjectionError("CASE_DASHBOARD_PROJECTION_INVALID");
  }
}

function hashProjection(projection: Omit<StoredCaseDashboardProjection, "contentHash">): string {
  const canonical = [
    projection.schemaVersion,
    projection.sourceSchemaVersion,
    projection.sourceSnapshotId,
    projection.sourceCapturedAtMs,
    projection.organizationId,
    projection.cases.map((item) => [
      item.caseId,
      item.caseNumber,
      item.studentDisplayName,
      item.stage,
      item.blockerCount,
      item.nextAction,
      item.nextActionDueAtMs,
      item.educationProfileCompleteness,
      item.schoolTargetCount,
      item.openTaskCount,
      item.unreadCommunicationCount,
    ]),
  ];
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index]);
}

function isSafeLabel(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= maxLength;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isBoundedCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 1_000_000;
}
