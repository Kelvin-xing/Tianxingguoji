import assert from "node:assert/strict";
import test from "node:test";

import type { IdentitySessionActor } from "../../modules/identity/infrastructure/in-memory-session-repository.ts";
import {
  CaseOutcomeError,
  CaseOutcomeService,
  type SchoolTargetTransitionCommand,
} from "../../modules/cases/application/outcome-service.ts";
import {
  evaluateCaseTransitionPolicy,
  evaluateSchoolTargetTransitionPolicy,
  HK_K12_STANDARD_V1_TEMPLATE,
} from "../../modules/cases/domain/transition-policy.ts";
import { InMemoryCaseTargetOutcomeRepository } from "../fakes/case-target-outcome.ts";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const CASE_ID = "22222222-2222-4222-8222-222222222222";
const TARGET_ID = "33333333-3333-4333-8333-333333333333";
const PRIMARY_ADVISOR_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_ADVISOR_ID = "55555555-5555-4555-8555-555555555555";

const PRIMARY_ADVISOR = actor(PRIMARY_ADVISOR_ID, "advisor");
const OTHER_ADVISOR = actor(OTHER_ADVISOR_ID, "advisor");

class FixedClock {
  nowMs(): number {
    return 1_754_265_600_000;
  }
}

function actor(userId: string, role: IdentitySessionActor["role"]): IdentitySessionActor {
  return Object.freeze({
    userId,
    organizationId: ORGANIZATION_ID,
    role,
    sessionId: "66666666-6666-4666-8666-666666666666",
    capturedSessionVersion: 1,
    reauthenticatedAtMs: 1_754_265_600_000,
  });
}

function setup(state: SchoolTargetTransitionCommand["toState"] = "candidate") {
  const repository = new InMemoryCaseTargetOutcomeRepository();
  for (const currentActor of [PRIMARY_ADVISOR, OTHER_ADVISOR]) {
    repository.activateUser({
      organizationId: currentActor.organizationId,
      userId: currentActor.userId,
      role: currentActor.role,
    });
  }
  repository.seedCase({
    caseId: CASE_ID,
    organizationId: ORGANIZATION_ID,
    primaryAdvisorUserId: PRIMARY_ADVISOR_ID,
  });
  repository.seedTarget({ targetId: TARGET_ID, caseId: CASE_ID, state });
  return {
    repository,
    service: new CaseOutcomeService({
      repository,
      clock: new FixedClock(),
      createId: sequenceIds(100),
    }),
  };
}

function evidence(overrides: Partial<SchoolTargetTransitionCommand["evidence"]> = {}) {
  return {
    dueDate: null,
    checklistCompleteReceipt: null,
    officialSubmissionReference: null,
    invitationEvidence: null,
    interviewAt: null,
    ...overrides,
  };
}

function command(overrides: Partial<SchoolTargetTransitionCommand> = {}): SchoolTargetTransitionCommand {
  return {
    toState: "preparing",
    expectedRecordVersion: 1,
    evidence: evidence(),
    outcome: null,
    requestId: "request-p2-03-target-001",
    idempotencyKey: "case-target-p2-03-001",
    ...overrides,
  };
}

function outcome(code: "waitlisted" | "accepted" | "rejected" | "withdrawn" | "not_submitted" | "aborted") {
  return {
    code,
    occurredOn: "2026-08-07",
    evidenceSource: "official_portal" as const,
    sourceReference: "portal-receipt-001",
  };
}

test("case breadth keeps lifecycle overlays separate from stages and enforces every OD-04 boundary", () => {
  const baseline = {
    actorRole: "advisor" as const,
    actorIsCurrentPrimaryAdvisor: true,
    stage: "background_collection" as const,
    lifecycleState: "active" as const,
    pausedPreviousStage: null,
    toStage: "school_selection_confirmed" as const,
    hasReason: true,
    approvedManifest: true,
    backgroundBlockersComplete: true,
    schoolSelectionBlockersComplete: true,
    allTargetsTerminalWithOutcomes: true,
    hasOpenTasks: false,
  };
  assert.deepEqual(evaluateCaseTransitionPolicy({ ...baseline, action: "advance" }), {
    allowed: true,
    stage: "school_selection_confirmed",
    lifecycleState: "active",
    pausedPreviousStage: null,
  });
  assert.equal(
    evaluateCaseTransitionPolicy({
      ...baseline,
      action: "advance",
      schoolSelectionBlockersComplete: false,
    }).allowed,
    false,
  );
  assert.deepEqual(evaluateCaseTransitionPolicy({ ...baseline, action: "pause", toStage: null }), {
    allowed: true,
    stage: "background_collection",
    lifecycleState: "paused",
    pausedPreviousStage: "background_collection",
  });
  assert.deepEqual(
    evaluateCaseTransitionPolicy({
      ...baseline,
      action: "resume",
      actorRole: "founder",
      actorIsCurrentPrimaryAdvisor: false,
      lifecycleState: "paused",
      pausedPreviousStage: "background_collection",
      toStage: null,
    }),
    {
      allowed: true,
      stage: "background_collection",
      lifecycleState: "active",
      pausedPreviousStage: null,
    },
  );
  assert.equal(
    evaluateCaseTransitionPolicy({
      ...baseline,
      action: "cancel",
      actorRole: "founder",
      actorIsCurrentPrimaryAdvisor: false,
      stage: "application_submitted",
      toStage: null,
    }).allowed,
    false,
  );
  assert.equal(
    evaluateCaseTransitionPolicy({
      ...baseline,
      action: "close",
      actorRole: "founder",
      actorIsCurrentPrimaryAdvisor: false,
      stage: "offer_confirmed",
      toStage: null,
      allTargetsTerminalWithOutcomes: false,
    }).allowed,
    false,
  );
  assert.deepEqual(
    evaluateCaseTransitionPolicy({
      ...baseline,
      action: "close",
      actorRole: "founder",
      actorIsCurrentPrimaryAdvisor: false,
      stage: "offer_confirmed",
      toStage: null,
    }),
    { allowed: true, stage: "closed", lifecycleState: "active", pausedPreviousStage: null },
  );
});

test("template requires the OD-05 evidence bundle for submission and interview", () => {
  assert.deepEqual(
    evaluateSchoolTargetTransitionPolicy({
      template: HK_K12_STANDARD_V1_TEMPLATE,
      from: "preparing",
      to: "submitted",
      evidence: evidence(),
    }),
    { allowed: false, code: "TARGET_EVIDENCE_REQUIRED" },
  );
  assert.deepEqual(
    evaluateSchoolTargetTransitionPolicy({
      template: HK_K12_STANDARD_V1_TEMPLATE,
      from: "preparing",
      to: "submitted",
      evidence: evidence({
        dueDate: "2026-09-01",
        checklistCompleteReceipt: "checklist-001",
        officialSubmissionReference: "application-001",
      }),
    }),
    { allowed: true, requiresOutcome: false },
  );
  assert.deepEqual(
    evaluateSchoolTargetTransitionPolicy({
      template: HK_K12_STANDARD_V1_TEMPLATE,
      from: "submitted",
      to: "interview",
      evidence: evidence({ invitationEvidence: "invite-001", interviewAt: "2026-09-08T09:30:00.000Z" }),
    }),
    { allowed: true, requiresOutcome: false },
  );
});

test("terminal target facts atomically create an outcome and corrections append a new outcome revision", async () => {
  const { repository, service } = setup("submitted");
  const terminal = await service.transitionSchoolTarget({
    actor: PRIMARY_ADVISOR,
    caseId: CASE_ID,
    targetId: TARGET_ID,
    command: command({
      toState: "waitlisted",
      outcome: outcome("waitlisted"),
      idempotencyKey: "case-target-p2-03-terminal-001",
    }),
  });
  assert.deepEqual(terminal, {
    targetId: TARGET_ID,
    caseId: CASE_ID,
    state: "waitlisted",
    recordVersion: 2,
    outcome: {
      outcomeRevisionId: "00000000-0000-4000-8000-000000000102",
      targetId: TARGET_ID,
      code: "waitlisted",
      recordVersion: 1,
    },
  });
  const corrected = await service.correctCaseOutcome({
    actor: PRIMARY_ADVISOR,
    caseId: CASE_ID,
    targetId: TARGET_ID,
    command: {
      expectedOutcomeRecordVersion: 1,
      outcome: { ...outcome("waitlisted"), evidenceSource: "advisor_attested", sourceReference: "advisor-note-001" },
      requestId: "request-p2-03-correction-001",
      idempotencyKey: "case-target-p2-03-correction-001",
    },
  });
  assert.deepEqual(corrected, {
    outcomeRevisionId: "00000000-0000-4000-8000-000000000105",
    targetId: TARGET_ID,
    code: "waitlisted",
    recordVersion: 2,
  });
  assert.deepEqual(repository.targetState(TARGET_ID), {
    state: "waitlisted",
    recordVersion: 2,
    currentOutcome: corrected,
  });
  assert.deepEqual(repository.snapshot(), {
    targets: 1,
    transitionFacts: 1,
    outcomeRevisions: 2,
    audits: 2,
    outbox: 2,
    idempotencyResults: 2,
  });
  assert.doesNotMatch(JSON.stringify(repository.lastEffects(TARGET_ID)), /portal-receipt|advisor-note/i);
});

test("terminal evidence, exact code, current Primary Advisor, stale version, and atomic failure deny", async () => {
  const missing = setup("submitted");
  await assert.rejects(
    missing.service.transitionSchoolTarget({
      actor: PRIMARY_ADVISOR,
      caseId: CASE_ID,
      targetId: TARGET_ID,
      command: command({ toState: "accepted", outcome: null }),
    }),
    outcomeError("CASE_OUTCOME_REQUIRED"),
  );
  await assert.rejects(
    missing.service.transitionSchoolTarget({
      actor: PRIMARY_ADVISOR,
      caseId: CASE_ID,
      targetId: TARGET_ID,
      command: command({ toState: "accepted", outcome: outcome("rejected") }),
    }),
    outcomeError("CASE_OUTCOME_CODE_INVALID"),
  );
  await assert.rejects(
    missing.service.transitionSchoolTarget({
      actor: OTHER_ADVISOR,
      caseId: CASE_ID,
      targetId: TARGET_ID,
      command: command({ toState: "accepted", outcome: outcome("accepted") }),
    }),
    outcomeError("CASE_OUTCOME_CASE_FORBIDDEN"),
  );
  await assert.rejects(
    missing.service.transitionSchoolTarget({
      actor: PRIMARY_ADVISOR,
      caseId: CASE_ID,
      targetId: TARGET_ID,
      command: command({ expectedRecordVersion: 2, toState: "accepted", outcome: outcome("accepted") }),
    }),
    outcomeError("CASE_OUTCOME_STALE_VERSION"),
  );
  const failing = setup("submitted");
  failing.repository.failOnceBeforeCommit();
  await assert.rejects(
    failing.service.transitionSchoolTarget({
      actor: PRIMARY_ADVISOR,
      caseId: CASE_ID,
      targetId: TARGET_ID,
      command: command({ toState: "accepted", outcome: outcome("accepted") }),
    }),
    /synthetic transaction failure/,
  );
  assert.deepEqual(failing.repository.snapshot(), {
    targets: 1,
    transitionFacts: 0,
    outcomeRevisions: 0,
    audits: 0,
    outbox: 0,
    idempotencyResults: 0,
  });
});

function outcomeError(code: CaseOutcomeError["code"]) {
  return (error: unknown) => error instanceof CaseOutcomeError && error.code === code;
}

function sequenceIds(start: number): () => string {
  let current = start;
  return () => {
    current += 1;
    return `00000000-0000-4000-8000-${String(current).padStart(12, "0")}`;
  };
}
