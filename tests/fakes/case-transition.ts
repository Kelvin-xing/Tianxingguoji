import type { MutationEffectBundle } from "../../modules/audit/contract.ts";
import type { OrganizationRole } from "../../modules/access/contract.ts";
import type { ServiceCaseStage } from "../../modules/cases/contract.ts";
import {
  CaseTransitionError,
  type CaseTransitionRepository,
  type CaseTransitionRepositoryInput,
  type CaseTransitionResult,
} from "../../modules/cases/transition-service.ts";

interface StoredCase {
  readonly caseId: string;
  readonly organizationId: string;
  readonly primaryAdvisorUserId: string;
  stage: "signed" | "background_collection";
  recordVersion: number;
  assessmentManifestApproved: boolean;
  assessmentStatus: "draft" | "background_complete";
  assessmentBlockersComplete: boolean;
}

interface StoredIdempotencyResult {
  readonly requestHash: string;
  readonly result: CaseTransitionResult;
}

/**
 * Deterministic P1-14 transaction-port fake. It proves the command contract
 * only; production must replace it with one HK RDS transaction.
 */
export class InMemoryCaseTransitionRepository implements CaseTransitionRepository {
  private readonly cases = new Map<string, StoredCase>();
  private readonly activeRoles = new Map<string, OrganizationRole>();
  private readonly visibleCaseKeys = new Set<string>();
  private readonly resultsByIdempotency = new Map<string, StoredIdempotencyResult>();
  private readonly transitionFactIds = new Set<string>();
  private readonly auditIds = new Set<string>();
  private readonly outboxIds = new Set<string>();
  private lastCommittedEffects: MutationEffectBundle | null = null;
  private failNextCommit = false;

  activateUser(input: {
    readonly organizationId: string;
    readonly userId: string;
    readonly role: OrganizationRole;
  }): void {
    this.activeRoles.set(actorKey(input.organizationId, input.userId), input.role);
  }

  grantCaseVisibility(input: {
    readonly organizationId: string;
    readonly caseId: string;
    readonly userId: string;
  }): void {
    this.visibleCaseKeys.add(visibilityKey(input.organizationId, input.caseId, input.userId));
  }

  seedCase(input: {
    readonly caseId: string;
    readonly organizationId: string;
    readonly primaryAdvisorUserId: string;
    readonly stage?: "signed" | "background_collection";
    readonly recordVersion?: number;
    readonly assessmentManifestApproved?: boolean;
    readonly assessmentStatus?: "draft" | "background_complete";
    readonly assessmentBlockersComplete?: boolean;
  }): void {
    this.cases.set(input.caseId, {
      caseId: input.caseId,
      organizationId: input.organizationId,
      primaryAdvisorUserId: input.primaryAdvisorUserId,
      stage: input.stage ?? "signed",
      recordVersion: input.recordVersion ?? 1,
      assessmentManifestApproved: input.assessmentManifestApproved ?? false,
      assessmentStatus: input.assessmentStatus ?? "draft",
      assessmentBlockersComplete: input.assessmentBlockersComplete ?? false,
    });
  }

  completeAssessmentEvidence(caseId: string): void {
    const serviceCase = this.caseForFixture(caseId);
    serviceCase.assessmentManifestApproved = true;
    serviceCase.assessmentStatus = "background_complete";
    serviceCase.assessmentBlockersComplete = true;
  }

  failOnceBeforeCommit(): void {
    this.failNextCommit = true;
  }

  snapshot(): Readonly<{
    cases: number;
    transitionFacts: number;
    audits: number;
    outbox: number;
    idempotencyResults: number;
  }> {
    return Object.freeze({
      cases: this.cases.size,
      transitionFacts: this.transitionFactIds.size,
      audits: this.auditIds.size,
      outbox: this.outboxIds.size,
      idempotencyResults: this.resultsByIdempotency.size,
    });
  }

  caseState(caseId: string): Readonly<{ stage: ServiceCaseStage; recordVersion: number }> {
    const serviceCase = this.caseForFixture(caseId);
    return Object.freeze({ stage: serviceCase.stage, recordVersion: serviceCase.recordVersion });
  }

  lastEffects(): MutationEffectBundle | null {
    return this.lastCommittedEffects;
  }

  async transitionServiceCase(input: CaseTransitionRepositoryInput): Promise<CaseTransitionResult> {
    const serviceCase = this.cases.get(input.caseId);
    if (!serviceCase || serviceCase.organizationId !== input.organizationId) {
      throw new CaseTransitionError("CASE_TRANSITION_CASE_NOT_FOUND");
    }
    if (!this.visibleCaseKeys.has(visibilityKey(input.organizationId, input.caseId, input.actor.userId))) {
      throw new CaseTransitionError("CASE_TRANSITION_CASE_NOT_FOUND");
    }
    if (this.activeRoles.get(actorKey(input.organizationId, input.actor.userId)) !== input.actor.role) {
      throw new CaseTransitionError("CASE_TRANSITION_CASE_FORBIDDEN");
    }

    const idempotencyScope = [
      input.organizationId,
      input.actor.userId,
      "cases.service_case.transition",
      input.idempotencyKey,
    ].join(":");
    const replay = this.resultsByIdempotency.get(idempotencyScope);
    if (replay) {
      if (replay.requestHash !== input.requestHash) {
        throw new CaseTransitionError("CASE_TRANSITION_IDEMPOTENCY_KEY_REUSED");
      }
      return replay.result;
    }

    if (serviceCase.recordVersion !== input.expectedRecordVersion) {
      throw new CaseTransitionError("CASE_TRANSITION_STALE_VERSION", {
        currentRecordVersion: serviceCase.recordVersion,
      });
    }
    if (serviceCase.stage !== input.fromStage) {
      throw new CaseTransitionError("CASE_TRANSITION_NOT_ALLOWED");
    }
    if (input.toStage === "background_collection") {
      if (serviceCase.primaryAdvisorUserId !== input.actor.userId) {
        throw new CaseTransitionError("CASE_TRANSITION_PRIMARY_ADVISOR_REQUIRED");
      }
      if (
        !serviceCase.assessmentManifestApproved ||
        serviceCase.assessmentStatus !== "background_complete" ||
        !serviceCase.assessmentBlockersComplete
      ) {
        throw new CaseTransitionError("CASE_TRANSITION_ASSESSMENT_INCOMPLETE");
      }
    } else if (input.toStage === "signed") {
      if (input.actor.role !== "founder") {
        throw new CaseTransitionError("CASE_TRANSITION_FOUNDER_REQUIRED");
      }
      if (input.reason === null) throw new CaseTransitionError("CASE_TRANSITION_REASON_REQUIRED");
    } else {
      throw new CaseTransitionError("CASE_TRANSITION_NOT_ALLOWED");
    }

    const result: CaseTransitionResult = Object.freeze({
      caseId: input.caseId,
      stage: input.toStage,
      recordVersion: serviceCase.recordVersion + 1,
    });
    const nextCases = new Map(this.cases);
    const nextResults = new Map(this.resultsByIdempotency);
    const nextTransitionFacts = new Set(this.transitionFactIds);
    const nextAudits = new Set(this.auditIds);
    const nextOutbox = new Set(this.outboxIds);
    nextCases.set(input.caseId, {
      ...serviceCase,
      stage: input.toStage,
      recordVersion: result.recordVersion,
    });
    nextResults.set(idempotencyScope, { requestHash: input.requestHash, result });
    nextTransitionFacts.add(input.transitionFactId);
    nextAudits.add(input.effects.audit.id);
    nextOutbox.add(input.effects.outbox.id);

    if (this.failNextCommit) {
      this.failNextCommit = false;
      throw new Error("synthetic transaction failure");
    }

    this.cases.clear();
    for (const [key, value] of nextCases) this.cases.set(key, value);
    this.resultsByIdempotency.clear();
    for (const [key, value] of nextResults) this.resultsByIdempotency.set(key, value);
    replaceSet(this.transitionFactIds, nextTransitionFacts);
    replaceSet(this.auditIds, nextAudits);
    replaceSet(this.outboxIds, nextOutbox);
    this.lastCommittedEffects = input.effects;
    return result;
  }

  private caseForFixture(caseId: string): StoredCase {
    const serviceCase = this.cases.get(caseId);
    if (!serviceCase) throw new Error("synthetic case not found");
    return serviceCase;
  }
}

function actorKey(organizationId: string, userId: string): string {
  return `${organizationId}:${userId}`;
}

function visibilityKey(organizationId: string, caseId: string, userId: string): string {
  return `${organizationId}:${caseId}:${userId}`;
}

function replaceSet(target: Set<string>, source: ReadonlySet<string>): void {
  target.clear();
  for (const value of source) target.add(value);
}
