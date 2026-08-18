import type { OrganizationRole } from "../../modules/access/domain/contract.ts";
import type { MutationEffectBundle } from "../../modules/audit/domain/contract.ts";
import {
  disableSchoolOverlay,
  type SchoolBaseRecord,
  type SchoolOverlayRevision,
} from "../../modules/schools/domain/contract.ts";
import {
  persistResolvedSchoolPin,
  resolveSchoolTargetView,
  SchoolResolutionError,
  type DisableSchoolOverlayResult,
  type ResolvedSchoolViewRepository,
  type SchoolResolutionSource,
} from "../../modules/schools/application/resolved-view.ts";
import {
  SchoolTargetError,
  type SchoolTargetRepository,
  type SchoolTargetResult,
} from "../../modules/cases/application/school-target-service.ts";

interface StoredCase {
  readonly organizationId: string;
  readonly primaryAdvisorUserId: string;
  readonly active: boolean;
  readonly stage: "signed" | "background_collection" | "school_selection_confirmed";
  readonly intakeYear: number;
  readonly admissionType: string;
}

interface StoredOverlay {
  readonly revision: SchoolOverlayRevision;
  readonly recordVersion: number;
}

interface StoredTarget {
  readonly caseId: string;
  readonly result: SchoolTargetResult;
}

interface StoredResult<Result> {
  readonly requestHash: string;
  readonly result: Result;
}

/**
 * One deterministic P1-09 test adapter for the SchoolIntelligence and
 * CaseWorkflow ports. It stages every mutation before replacement to model
 * the required RDS transaction without becoming a runtime fallback.
 */
export class InMemorySchoolTargetRepository
  implements SchoolTargetRepository, ResolvedSchoolViewRepository
{
  private readonly activeRoles = new Map<string, OrganizationRole>();
  private readonly cases = new Map<string, StoredCase>();
  private readonly bases = new Map<string, SchoolBaseRecord>();
  private overlays = new Map<string, StoredOverlay>();
  private targets = new Map<string, StoredTarget>();
  private resolvedRevisionIds = new Set<string>();
  private targetResults = new Map<string, StoredResult<SchoolTargetResult>>();
  private overlayResults = new Map<string, StoredResult<DisableSchoolOverlayResult>>();
  private effects = new Map<string, MutationEffectBundle>();
  private failNextCommit = false;

  activateUser(input: {
    readonly organizationId: string;
    readonly userId: string;
    readonly role: OrganizationRole;
  }): void {
    this.activeRoles.set(actorKey(input.organizationId, input.userId), input.role);
  }

  seedCase(input: {
    readonly caseId: string;
    readonly organizationId: string;
    readonly primaryAdvisorUserId: string;
    readonly active?: boolean;
    readonly stage?: StoredCase["stage"];
    readonly intakeYear?: number;
    readonly admissionType?: string;
  }): void {
    this.cases.set(input.caseId, {
      organizationId: input.organizationId,
      primaryAdvisorUserId: input.primaryAdvisorUserId,
      active: input.active ?? true,
      stage: input.stage ?? "background_collection",
      intakeYear: input.intakeYear ?? 2027,
      admissionType: input.admissionType ?? "hk_k12_standard_v1",
    });
  }

  seedBase(base: SchoolBaseRecord): void {
    this.bases.set(baseKey(base.organizationId, base.schoolId), base);
  }

  seedOverlay(input: { readonly revision: SchoolOverlayRevision; readonly recordVersion?: number }): void {
    this.overlays.set(input.revision.revisionId, {
      revision: input.revision,
      recordVersion: input.recordVersion ?? 1,
    });
  }

  failOnceBeforeCommit(): void {
    this.failNextCommit = true;
  }

  snapshot(): Readonly<{
    targets: number;
    overlays: number;
    resolvedRevisions: number;
    audits: number;
    outbox: number;
    targetIdempotencyResults: number;
    overlayIdempotencyResults: number;
  }> {
    return Object.freeze({
      targets: this.targets.size,
      overlays: this.overlays.size,
      resolvedRevisions: this.resolvedRevisionIds.size,
      audits: this.effects.size,
      outbox: this.effects.size,
      targetIdempotencyResults: this.targetResults.size,
      overlayIdempotencyResults: this.overlayResults.size,
    });
  }

  target(targetId: string): SchoolTargetResult | undefined {
    return this.targets.get(targetId)?.result;
  }

  overlay(overlayRevisionId: string): StoredOverlay | undefined {
    return this.overlays.get(overlayRevisionId);
  }

  effectsFor(resourceId: string): MutationEffectBundle | undefined {
    return this.effects.get(resourceId);
  }

  async readResolvedSchool(
    input: Parameters<ResolvedSchoolViewRepository["readResolvedSchool"]>[0],
  ): Promise<SchoolResolutionSource> {
    const role = this.activeRoles.get(actorKey(input.organizationId, input.actorUserId));
    if (role !== "advisor" && role !== "founder" && role !== "data_reviewer") {
      throw new SchoolResolutionError("SCHOOL_RESOLUTION_FORBIDDEN");
    }
    try {
      return this.sourceForSchool(input.organizationId, input.schoolId);
    } catch (error) {
      if (
        error instanceof SchoolTargetError &&
        error.code === "SCHOOL_TARGET_RESOLUTION_NOT_FOUND"
      ) {
        throw new SchoolResolutionError("SCHOOL_RESOLUTION_NOT_FOUND");
      }
      throw error;
    }
  }

  async readSchoolTargetWorkspace(
    input: Parameters<SchoolTargetRepository["readSchoolTargetWorkspace"]>[0],
  ) {
    const serviceCase = this.assertReadableCase(
      input.organizationId,
      input.actorUserId,
      input.actorRole,
      input.caseId,
    );
    const items = [...this.targets.values()]
      .filter((target) => target.caseId === input.caseId)
      .map(({ result }) => result)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) ||
        left.targetId.localeCompare(right.targetId));
    const targeted = new Set(items.map((target) => target.schoolId));
    const schoolOptions = [...this.bases.values()]
      .filter((base) => base.organizationId === input.organizationId && !targeted.has(base.schoolId))
      .map((base) => resolveSchoolTargetView(this.sourceForSchool(
        input.organizationId,
        base.schoolId,
      )))
      .map((resolved) => Object.freeze({
        schoolId: resolved.view.schoolId,
        displayName: displayName(resolved.view.fields, resolved.view.sourceSchoolKey),
        resolutionSha256: resolved.view.resolutionSha256,
      }))
      .sort((left, right) => left.displayName.localeCompare(right.displayName) ||
        left.schoolId.localeCompare(right.schoolId));
    return Object.freeze({
      caseId: input.caseId,
      caseStage: serviceCase.stage,
      intakeYear: serviceCase.intakeYear,
      admissionType: serviceCase.admissionType,
      items: Object.freeze(items),
      schoolOptions: Object.freeze(schoolOptions),
    });
  }

  async createSchoolTarget(
    input: Parameters<SchoolTargetRepository["createSchoolTarget"]>[0],
  ): Promise<SchoolTargetResult> {
    const serviceCase = this.assertPrimaryAdvisor(
      input.organizationId,
      input.actorUserId,
      input.caseId,
    );
    const scope = [
      input.organizationId,
      input.actorUserId,
      "cases.school_target.create",
      input.idempotencyKey,
    ].join(":");
    const existing = this.targetResults.get(scope);
    if (existing) {
      if (existing.requestHash !== input.requestHash) {
        throw new SchoolTargetError("SCHOOL_TARGET_IDEMPOTENCY_KEY_REUSED");
      }
      return existing.result;
    }

    if (serviceCase.stage !== "background_collection") {
      throw new SchoolTargetError("SCHOOL_TARGET_STAGE_NOT_ALLOWED");
    }
    const current = resolveSchoolTargetView(this.sourceForSchool(input.organizationId, input.schoolId));
    if (current.pin.resolutionSha256 !== input.expectedResolutionSha256) {
      throw new SchoolTargetError("SCHOOL_TARGET_RESOLUTION_STALE");
    }
    for (const target of this.targets.values()) {
      if (
        target.caseId === input.caseId &&
        target.result.schoolId === input.schoolId
      ) {
        throw new SchoolTargetError("SCHOOL_TARGET_DUPLICATE");
      }
    }

    const result: SchoolTargetResult = Object.freeze({
      targetId: input.targetId,
      schoolId: input.schoolId,
      schoolName: displayName(current.view.fields, current.view.sourceSchoolKey),
      state: "candidate",
      intakeYear: serviceCase.intakeYear,
      admissionType: serviceCase.admissionType,
      recordVersion: 1,
      resolvedRevisionId: input.proposedResolvedRevisionId,
      resolutionSha256: current.view.resolutionSha256,
      createdAt: new Date(input.createdAtMs).toISOString(),
    });
    const nextTargets = new Map(this.targets);
    const nextResolvedRevisionIds = new Set(this.resolvedRevisionIds);
    const nextResults = new Map(this.targetResults);
    const nextEffects = new Map(this.effects);
    nextTargets.set(input.targetId, { caseId: input.caseId, result });
    nextResults.set(scope, { requestHash: input.requestHash, result });
    nextEffects.set(input.targetId, input.effects);
    nextResolvedRevisionIds.add(input.proposedResolvedRevisionId);

    this.commitOrFail(() => {
      this.targets = nextTargets;
      this.resolvedRevisionIds = nextResolvedRevisionIds;
      this.targetResults = nextResults;
      this.effects = nextEffects;
    });
    return result;
  }

  async disableApprovedOverlay(
    input: Parameters<ResolvedSchoolViewRepository["disableApprovedOverlay"]>[0],
  ): Promise<DisableSchoolOverlayResult> {
    const scope = [
      input.organizationId,
      input.actorUserId,
      "schools.overlay.disable",
      input.idempotencyKey,
    ].join(":");
    const existing = this.overlayResults.get(scope);
    if (existing) {
      if (existing.requestHash !== input.requestHash) {
        throw new SchoolResolutionError("SCHOOL_OVERLAY_IDEMPOTENCY_KEY_REUSED");
      }
      return existing.result;
    }

    if (this.activeRoles.get(actorKey(input.organizationId, input.actorUserId)) !== input.actorRole) {
      throw new SchoolResolutionError("SCHOOL_OVERLAY_REVIEWER_REQUIRED");
    }
    const stored = this.overlays.get(input.overlayRevisionId);
    if (
      !stored ||
      stored.revision.organizationId !== input.organizationId ||
      stored.revision.schoolId !== input.schoolId
    ) {
      throw new SchoolResolutionError("SCHOOL_RESOLUTION_NOT_FOUND");
    }
    if (stored.revision.status !== "approved") {
      throw new SchoolResolutionError("SCHOOL_OVERLAY_NOT_APPROVED");
    }
    if (stored.recordVersion !== input.expectedRecordVersion) {
      throw new SchoolResolutionError("SCHOOL_OVERLAY_STALE_VERSION");
    }

    let disabled: SchoolOverlayRevision;
    try {
      disabled = disableSchoolOverlay(stored.revision, {
        disabledBy: input.actorUserId,
        reason: input.reason,
        disabledAt: new Date(input.disabledAtMs).toISOString(),
      });
    } catch (error) {
      if (error instanceof Error && error.message === "SCHOOL_REVIEWER_SELF_REVIEW_DENIED") {
        throw new SchoolResolutionError("SCHOOL_OVERLAY_SELF_REVIEW_DENIED");
      }
      throw error;
    }

    const nextOverlays = new Map(this.overlays);
    nextOverlays.set(input.overlayRevisionId, {
      revision: disabled,
      recordVersion: stored.recordVersion + 1,
    });
    const rollback = persistResolvedSchoolPin(
      resolveSchoolTargetView(
        this.sourceForSchool(input.organizationId, input.schoolId, nextOverlays),
      ),
      input.rollbackResolvedRevisionId,
    );
    const result: DisableSchoolOverlayResult = Object.freeze({
      overlayRevisionId: input.overlayRevisionId,
      recordVersion: stored.recordVersion + 1,
      rollback,
    });
    const nextResults = new Map(this.overlayResults);
    const nextResolvedRevisionIds = new Set(this.resolvedRevisionIds);
    const nextEffects = new Map(this.effects);
    nextResults.set(scope, { requestHash: input.requestHash, result });
    nextEffects.set(input.overlayRevisionId, input.effects);
    nextResolvedRevisionIds.add(input.rollbackResolvedRevisionId);

    this.commitOrFail(() => {
      this.overlays = nextOverlays;
      this.resolvedRevisionIds = nextResolvedRevisionIds;
      this.overlayResults = nextResults;
      this.effects = nextEffects;
    });
    return result;
  }

  private assertReadableCase(
    organizationId: string,
    actorUserId: string,
    actorRole: "founder" | "advisor",
    caseId: string,
  ): StoredCase {
    const serviceCase = this.cases.get(caseId);
    if (!serviceCase || serviceCase.organizationId !== organizationId || !serviceCase.active) {
      throw new SchoolTargetError("SCHOOL_TARGET_CASE_NOT_FOUND");
    }
    if (this.activeRoles.get(actorKey(organizationId, actorUserId)) !== actorRole) {
      throw new SchoolTargetError("SCHOOL_TARGET_CASE_NOT_FOUND");
    }
    if (actorRole === "advisor" && serviceCase.primaryAdvisorUserId !== actorUserId) {
      throw new SchoolTargetError("SCHOOL_TARGET_CASE_NOT_FOUND");
    }
    return serviceCase;
  }

  private assertPrimaryAdvisor(
    organizationId: string,
    actorUserId: string,
    caseId: string,
  ): StoredCase {
    const serviceCase = this.assertReadableCase(
      organizationId,
      actorUserId,
      "advisor",
      caseId,
    );
    if (
      serviceCase.primaryAdvisorUserId !== actorUserId ||
      this.activeRoles.get(actorKey(organizationId, actorUserId)) !== "advisor"
    ) {
      throw new SchoolTargetError("SCHOOL_TARGET_CASE_NOT_FOUND");
    }
    return serviceCase;
  }

  private sourceForSchool(
    organizationId: string,
    schoolId: string,
    overlays = this.overlays,
  ): SchoolResolutionSource {
    const base = this.bases.get(baseKey(organizationId, schoolId));
    if (!base) throw new SchoolTargetError("SCHOOL_TARGET_RESOLUTION_NOT_FOUND");
    return Object.freeze({
      base,
      revisions: Object.freeze(
        [...overlays.values()]
          .map(({ revision }) => revision)
          .filter(
            (revision) =>
              revision.organizationId === organizationId && revision.schoolId === schoolId,
          ),
      ),
    });
  }

  private commitOrFail(commit: () => void): void {
    if (this.failNextCommit) {
      this.failNextCommit = false;
      throw new Error("synthetic transaction failure");
    }
    commit();
  }
}

function actorKey(organizationId: string, userId: string): string {
  return `${organizationId}:${userId}`;
}

function baseKey(organizationId: string, schoolId: string): string {
  return `${organizationId}:${schoolId}`;
}

function displayName(fields: Readonly<Record<string, unknown>>, sourceSchoolKey: string): string {
  for (const value of [fields.school_name_zh, fields.school_name_en]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return sourceSchoolKey;
}
