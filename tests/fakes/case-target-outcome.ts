import type { OrganizationRole } from "../../modules/access/contract.ts";
import type { MutationEffectBundle } from "../../modules/audit/contract.ts";
import type { IdentitySessionActor } from "../../modules/identity/session-repository.ts";
import type { CaseOutcomeCode, SchoolTargetState } from "../../modules/cases/contract.ts";
import {
  CaseOutcomeError,
  type CaseOutcomeRepository,
  type CaseOutcomeRevisionResult,
  type SchoolTargetTransitionResult,
} from "../../modules/cases/outcome-service.ts";
import {
  HK_K12_STANDARD_V1_TEMPLATE,
  evaluateSchoolTargetTransitionPolicy,
  isTerminalSchoolTargetState,
  outcomeCodesForTargetState,
} from "../../modules/cases/transition-policy.ts";

interface StoredCase {
  readonly organizationId: string;
  readonly primaryAdvisorUserId: string;
}

interface StoredOutcome extends CaseOutcomeRevisionResult {
  readonly evidenceSource: string;
}

interface StoredTarget {
  readonly caseId: string;
  readonly state: SchoolTargetState;
  readonly recordVersion: number;
  readonly currentOutcome: StoredOutcome | null;
}

interface StoredResult<Result> {
  readonly requestHash: string;
  readonly result: Result;
}

/** Deterministic transaction-port fake for P2-03; never a runtime fallback. */
export class InMemoryCaseTargetOutcomeRepository implements CaseOutcomeRepository {
  private readonly cases = new Map<string, StoredCase>();
  private readonly activeRoles = new Map<string, OrganizationRole>();
  private targets = new Map<string, StoredTarget>();
  private readonly transitionResults = new Map<string, StoredResult<SchoolTargetTransitionResult>>();
  private readonly correctionResults = new Map<string, StoredResult<CaseOutcomeRevisionResult>>();
  private readonly transitionFactIds = new Set<string>();
  private readonly outcomeRevisionIds = new Set<string>();
  private readonly effects = new Map<string, MutationEffectBundle>();
  private failNextCommit = false;

  activateUser(input: { readonly organizationId: string; readonly userId: string; readonly role: OrganizationRole }): void {
    this.activeRoles.set(actorKey(input.organizationId, input.userId), input.role);
  }

  seedCase(input: { readonly caseId: string; readonly organizationId: string; readonly primaryAdvisorUserId: string }): void {
    this.cases.set(input.caseId, {
      organizationId: input.organizationId,
      primaryAdvisorUserId: input.primaryAdvisorUserId,
    });
  }

  seedTarget(input: {
    readonly targetId: string;
    readonly caseId: string;
    readonly state?: SchoolTargetState;
    readonly recordVersion?: number;
    readonly currentOutcome?: StoredOutcome | null;
  }): void {
    this.targets.set(input.targetId, {
      caseId: input.caseId,
      state: input.state ?? "candidate",
      recordVersion: input.recordVersion ?? 1,
      currentOutcome: input.currentOutcome ?? null,
    });
  }

  failOnceBeforeCommit(): void {
    this.failNextCommit = true;
  }

  targetState(targetId: string): Readonly<{
    state: SchoolTargetState;
    recordVersion: number;
    currentOutcome: CaseOutcomeRevisionResult | null;
  }> {
    const target = this.targetForFixture(targetId);
    return Object.freeze({
      state: target.state,
      recordVersion: target.recordVersion,
      currentOutcome:
        target.currentOutcome === null ? null : toOutcomeResult(target.currentOutcome),
    });
  }

  snapshot(): Readonly<{
    targets: number;
    transitionFacts: number;
    outcomeRevisions: number;
    audits: number;
    outbox: number;
    idempotencyResults: number;
  }> {
    return Object.freeze({
      targets: this.targets.size,
      transitionFacts: this.transitionFactIds.size,
      outcomeRevisions: this.outcomeRevisionIds.size,
      audits: this.effects.size,
      outbox: this.effects.size,
      idempotencyResults: this.transitionResults.size + this.correctionResults.size,
    });
  }

  lastEffects(resourceId: string): MutationEffectBundle | undefined {
    return this.effects.get(resourceId);
  }

  async transitionSchoolTarget(
    input: Parameters<CaseOutcomeRepository["transitionSchoolTarget"]>[0],
  ): Promise<SchoolTargetTransitionResult> {
    this.assertPrimaryAdvisor(input.actor, input.caseId);
    const target = this.targetForCase(input.targetId, input.caseId, input.organizationId);
    const scope = idempotencyScope(input.actor, "cases.school_target.transition", input.command.idempotencyKey);
    const replay = this.transitionResults.get(scope);
    if (replay) {
      if (replay.requestHash !== input.requestHash) {
        throw new CaseOutcomeError("CASE_OUTCOME_IDEMPOTENCY_KEY_REUSED");
      }
      return replay.result;
    }
    if (target.recordVersion !== input.command.expectedRecordVersion) {
      throw new CaseOutcomeError("CASE_OUTCOME_STALE_VERSION", {
        currentRecordVersion: target.recordVersion,
      });
    }

    const decision = evaluateSchoolTargetTransitionPolicy({
      template: HK_K12_STANDARD_V1_TEMPLATE,
      from: target.state,
      to: input.command.toState,
      evidence: input.command.evidence,
    });
    if (!decision.allowed) throw mapPolicyError(decision.code);
    if (decision.requiresOutcome && input.command.outcome === null) {
      throw new CaseOutcomeError("CASE_OUTCOME_REQUIRED");
    }
    if (!decision.requiresOutcome && input.command.outcome !== null) {
      throw new CaseOutcomeError("CASE_OUTCOME_CODE_INVALID");
    }
    if (input.command.outcome !== null) {
      assertOutcomeForTarget(input.command.toState, input.command.outcome.code, input.command.outcome.evidenceSource);
    }

    const storedOutcome = input.command.outcome === null
      ? null
      : Object.freeze({
          outcomeRevisionId: requiredId(input.outcomeRevisionId),
          targetId: input.targetId,
          code: input.command.outcome.code,
          recordVersion: target.currentOutcome === null ? 1 : target.currentOutcome.recordVersion + 1,
          evidenceSource: input.command.outcome.evidenceSource,
        });
    const result: SchoolTargetTransitionResult = Object.freeze({
      targetId: input.targetId,
      caseId: input.caseId,
      state: input.command.toState,
      recordVersion: target.recordVersion + 1,
      outcome: storedOutcome === null ? null : toOutcomeResult(storedOutcome),
    });
    const nextTargets = new Map(this.targets);
    const nextTransitionResults = new Map(this.transitionResults);
    const nextTransitionFactIds = new Set(this.transitionFactIds);
    const nextOutcomeRevisionIds = new Set(this.outcomeRevisionIds);
    const nextEffects = new Map(this.effects);
    nextTargets.set(input.targetId, {
      caseId: target.caseId,
      state: result.state,
      recordVersion: result.recordVersion,
      currentOutcome: storedOutcome,
    });
    nextTransitionResults.set(scope, { requestHash: input.requestHash, result });
    nextTransitionFactIds.add(input.transitionFactId);
    if (storedOutcome !== null) nextOutcomeRevisionIds.add(storedOutcome.outcomeRevisionId);
    nextEffects.set(input.targetId, input.effects);
    this.commitOrFail(() => {
      this.targets = nextTargets;
      replaceMap(this.transitionResults, nextTransitionResults);
      replaceSet(this.transitionFactIds, nextTransitionFactIds);
      replaceSet(this.outcomeRevisionIds, nextOutcomeRevisionIds);
      replaceMap(this.effects, nextEffects);
    });
    return result;
  }

  async correctCaseOutcome(
    input: Parameters<CaseOutcomeRepository["correctCaseOutcome"]>[0],
  ): Promise<CaseOutcomeRevisionResult> {
    this.assertPrimaryAdvisor(input.actor, input.caseId);
    const target = this.targetForCase(input.targetId, input.caseId, input.organizationId);
    const scope = idempotencyScope(input.actor, "cases.case_outcome.correct", input.command.idempotencyKey);
    const replay = this.correctionResults.get(scope);
    if (replay) {
      if (replay.requestHash !== input.requestHash) {
        throw new CaseOutcomeError("CASE_OUTCOME_IDEMPOTENCY_KEY_REUSED");
      }
      return replay.result;
    }
    if (!isTerminalSchoolTargetState(target.state) || target.currentOutcome === null) {
      throw new CaseOutcomeError("CASE_OUTCOME_TRANSITION_NOT_ALLOWED");
    }
    if (target.currentOutcome.recordVersion !== input.command.expectedOutcomeRecordVersion) {
      throw new CaseOutcomeError("CASE_OUTCOME_STALE_VERSION", {
        currentRecordVersion: target.currentOutcome.recordVersion,
      });
    }
    assertOutcomeForTarget(target.state, input.command.outcome.code, input.command.outcome.evidenceSource);
    const storedOutcome: StoredOutcome = Object.freeze({
      outcomeRevisionId: input.outcomeRevisionId,
      targetId: input.targetId,
      code: input.command.outcome.code,
      recordVersion: target.currentOutcome.recordVersion + 1,
      evidenceSource: input.command.outcome.evidenceSource,
    });
    const result = toOutcomeResult(storedOutcome);
    const nextTargets = new Map(this.targets);
    const nextCorrections = new Map(this.correctionResults);
    const nextOutcomeRevisionIds = new Set(this.outcomeRevisionIds);
    const nextEffects = new Map(this.effects);
    nextTargets.set(input.targetId, { ...target, currentOutcome: storedOutcome });
    nextCorrections.set(scope, { requestHash: input.requestHash, result });
    nextOutcomeRevisionIds.add(storedOutcome.outcomeRevisionId);
    nextEffects.set(storedOutcome.outcomeRevisionId, input.effects);
    this.commitOrFail(() => {
      this.targets = nextTargets;
      replaceMap(this.correctionResults, nextCorrections);
      replaceSet(this.outcomeRevisionIds, nextOutcomeRevisionIds);
      replaceMap(this.effects, nextEffects);
    });
    return result;
  }

  private assertPrimaryAdvisor(actor: IdentitySessionActor, caseId: string): void {
    const serviceCase = this.cases.get(caseId);
    if (!serviceCase || serviceCase.organizationId !== actor.organizationId) {
      throw new CaseOutcomeError("CASE_OUTCOME_CASE_NOT_FOUND");
    }
    if (
      actor.role !== "advisor" ||
      serviceCase.primaryAdvisorUserId !== actor.userId ||
      this.activeRoles.get(actorKey(actor.organizationId, actor.userId)) !== "advisor"
    ) {
      throw new CaseOutcomeError("CASE_OUTCOME_CASE_FORBIDDEN");
    }
  }

  private targetForCase(targetId: string, caseId: string, organizationId: string): StoredTarget {
    const target = this.targets.get(targetId);
    const serviceCase = this.cases.get(caseId);
    if (!target || target.caseId !== caseId || serviceCase?.organizationId !== organizationId) {
      throw new CaseOutcomeError("CASE_OUTCOME_TARGET_NOT_FOUND");
    }
    return target;
  }

  private targetForFixture(targetId: string): StoredTarget {
    const target = this.targets.get(targetId);
    if (!target) throw new Error("synthetic target not found");
    return target;
  }

  private commitOrFail(commit: () => void): void {
    if (this.failNextCommit) {
      this.failNextCommit = false;
      throw new Error("synthetic transaction failure");
    }
    commit();
  }
}

function assertOutcomeForTarget(
  targetState: SchoolTargetState,
  code: CaseOutcomeCode,
  source: string,
): void {
  if (!outcomeCodesForTargetState(targetState).includes(code)) {
    throw new CaseOutcomeError("CASE_OUTCOME_CODE_INVALID");
  }
  if (source !== "official_portal" && source !== "official_letter" && source !== "advisor_attested") {
    throw new CaseOutcomeError("CASE_OUTCOME_EVIDENCE_REQUIRED");
  }
}

function mapPolicyError(code: string): CaseOutcomeError {
  switch (code) {
    case "TARGET_ROUTE_POLICY_REQUIRED":
      return new CaseOutcomeError("CASE_OUTCOME_ROUTE_POLICY_REQUIRED");
    case "TARGET_EVIDENCE_REQUIRED":
      return new CaseOutcomeError("CASE_OUTCOME_EVIDENCE_REQUIRED");
    default:
      return new CaseOutcomeError("CASE_OUTCOME_TRANSITION_NOT_ALLOWED");
  }
}

function requiredId(value: string | null): string {
  if (value === null) throw new Error("synthetic outcome revision ID is required");
  return value;
}

function toOutcomeResult(outcome: StoredOutcome): CaseOutcomeRevisionResult {
  return Object.freeze({
    outcomeRevisionId: outcome.outcomeRevisionId,
    targetId: outcome.targetId,
    code: outcome.code,
    recordVersion: outcome.recordVersion,
  });
}

function actorKey(organizationId: string, userId: string): string {
  return `${organizationId}:${userId}`;
}

function idempotencyScope(actor: IdentitySessionActor, operation: string, idempotencyKey: string): string {
  return [actor.organizationId, actor.userId, operation, idempotencyKey].join(":");
}

function replaceSet(target: Set<string>, source: ReadonlySet<string>): void {
  target.clear();
  for (const value of source) target.add(value);
}

function replaceMap<Key, Value>(target: Map<Key, Value>, source: ReadonlyMap<Key, Value>): void {
  target.clear();
  for (const [key, value] of source) target.set(key, value);
}
