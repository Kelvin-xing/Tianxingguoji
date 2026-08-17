import assert from "node:assert/strict";
import test from "node:test";

import type { IdentitySessionActor } from "../../modules/identity/infrastructure/in-memory-session-repository.ts";
import {
  CaseTransitionError,
  CaseTransitionService,
  type TransitionServiceCaseCommand,
} from "../../modules/cases/application/transition-service.ts";
import { InMemoryCaseTransitionRepository } from "../fakes/case-transition.ts";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const CASE_ID = "22222222-2222-4222-8222-222222222222";
const PRIMARY_ADVISOR_ID = "33333333-3333-4333-8333-333333333333";
const FOUNDER_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_ADVISOR_ID = "55555555-5555-4555-8555-555555555555";
const OUTSIDER_ID = "66666666-6666-4666-8666-666666666666";

const PRIMARY_ADVISOR = actor(PRIMARY_ADVISOR_ID, "advisor");
const FOUNDER = actor(FOUNDER_ID, "founder");
const OTHER_ADVISOR = actor(OTHER_ADVISOR_ID, "advisor");
const OUTSIDER = actor(OUTSIDER_ID, "advisor");

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
    sessionId: "77777777-7777-4777-8777-777777777777",
    capturedSessionVersion: 1,
    reauthenticatedAtMs: 1_754_265_600_000,
  });
}

function createWorkflow(options: { readonly completeAssessment?: boolean } = {}) {
  const repository = new InMemoryCaseTransitionRepository();
  for (const currentActor of [PRIMARY_ADVISOR, FOUNDER, OTHER_ADVISOR, OUTSIDER]) {
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
  for (const currentActor of [PRIMARY_ADVISOR, FOUNDER, OTHER_ADVISOR]) {
    repository.grantCaseVisibility({
      organizationId: ORGANIZATION_ID,
      caseId: CASE_ID,
      userId: currentActor.userId,
    });
  }
  if (options.completeAssessment) repository.completeAssessmentEvidence(CASE_ID);

  return {
    repository,
    service: new CaseTransitionService({
      repository,
      clock: new FixedClock(),
      createId: sequenceIds(100),
    }),
  };
}

function command(
  overrides: Partial<TransitionServiceCaseCommand> = {},
): TransitionServiceCaseCommand {
  return {
    toStage: "background_collection",
    expectedRecordVersion: 1,
    reason: "assessment_evidence_complete",
    requestId: "request-p1-14-case-001",
    idempotencyKey: "case-transition-p1-14-001",
    ...overrides,
  };
}

async function transition(
  service: CaseTransitionService,
  currentActor: IdentitySessionActor,
  currentCommand: TransitionServiceCaseCommand,
) {
  return service.transitionServiceCase({
    actor: currentActor,
    caseId: CASE_ID,
    command: currentCommand,
  });
}

test("the current Primary Advisor advances signed to background_collection only with complete assessment evidence", async () => {
  const { repository, service } = createWorkflow({ completeAssessment: true });

  assert.deepEqual(
    await transition(service, PRIMARY_ADVISOR, command()),
    { caseId: CASE_ID, stage: "background_collection", recordVersion: 2 },
  );
  assert.deepEqual(repository.caseState(CASE_ID), {
    stage: "background_collection",
    recordVersion: 2,
  });
  assert.deepEqual(repository.snapshot(), {
    cases: 1,
    transitionFacts: 1,
    audits: 1,
    outbox: 1,
    idempotencyResults: 1,
  });
  assert.doesNotMatch(JSON.stringify(repository.lastEffects()), /assessment_evidence_complete/);
});

test("an incomplete manifest or assessment blocker set denies the forward transition without an effect", async () => {
  const { repository, service } = createWorkflow();

  await assert.rejects(
    transition(service, PRIMARY_ADVISOR, command()),
    caseTransitionError("CASE_TRANSITION_ASSESSMENT_INCOMPLETE"),
  );
  assert.deepEqual(repository.caseState(CASE_ID), { stage: "signed", recordVersion: 1 });
  assert.deepEqual(repository.snapshot(), {
    cases: 1,
    transitionFacts: 0,
    audits: 0,
    outbox: 0,
    idempotencyResults: 0,
  });
});

test("only a Founder rolls back background_collection to its immediately preceding signed stage with a reason", async () => {
  const { repository, service } = createWorkflow({ completeAssessment: true });
  await transition(service, PRIMARY_ADVISOR, command());

  await assert.rejects(
    transition(service, PRIMARY_ADVISOR, command({
      toStage: "signed",
      expectedRecordVersion: 2,
      reason: "rollback_required",
      idempotencyKey: "case-transition-p1-14-002",
    })),
    caseTransitionError("CASE_TRANSITION_FOUNDER_REQUIRED"),
  );
  await assert.rejects(
    transition(service, FOUNDER, command({
      toStage: "signed",
      expectedRecordVersion: 2,
      reason: "",
      idempotencyKey: "case-transition-p1-14-003",
    })),
    caseTransitionError("CASE_TRANSITION_REASON_REQUIRED"),
  );
  assert.deepEqual(
    await transition(service, FOUNDER, command({
      toStage: "signed",
      expectedRecordVersion: 2,
      reason: "manifest_correction",
      idempotencyKey: "case-transition-p1-14-004",
    })),
    { caseId: CASE_ID, stage: "signed", recordVersion: 3 },
  );
  assert.deepEqual(repository.snapshot(), {
    cases: 1,
    transitionFacts: 2,
    audits: 2,
    outbox: 2,
    idempotencyResults: 2,
  });
});

test("case visibility, Primary Advisor authority, stale versions, and unsupported states deny", async () => {
  const { repository, service } = createWorkflow({ completeAssessment: true });

  await assert.rejects(
    transition(service, OUTSIDER, command()),
    caseTransitionError("CASE_TRANSITION_CASE_NOT_FOUND"),
  );
  await assert.rejects(
    transition(service, OTHER_ADVISOR, command()),
    caseTransitionError("CASE_TRANSITION_PRIMARY_ADVISOR_REQUIRED"),
  );
  await assert.rejects(
    transition(service, PRIMARY_ADVISOR, command({ expectedRecordVersion: 2 })),
    caseTransitionError("CASE_TRANSITION_STALE_VERSION"),
  );
  await assert.rejects(
    transition(service, PRIMARY_ADVISOR, command({
      toStage: "closed",
      idempotencyKey: "case-transition-p1-14-005",
    })),
    caseTransitionError("CASE_TRANSITION_NOT_ALLOWED"),
  );
  assert.deepEqual(repository.snapshot(), {
    cases: 1,
    transitionFacts: 0,
    audits: 0,
    outbox: 0,
    idempotencyResults: 0,
  });
});

test("one idempotency result replays, while a pre-commit failure leaves no case transition partial fact", async () => {
  const { repository, service } = createWorkflow({ completeAssessment: true });
  const input = command({ idempotencyKey: "case-transition-p1-14-006" });

  const first = await transition(service, PRIMARY_ADVISOR, input);
  assert.deepEqual(await transition(service, PRIMARY_ADVISOR, input), first);
  await assert.rejects(
    transition(service, PRIMARY_ADVISOR, command({
      reason: "changed_payload",
      idempotencyKey: input.idempotencyKey,
    })),
    caseTransitionError("CASE_TRANSITION_IDEMPOTENCY_KEY_REUSED"),
  );
  assert.deepEqual(repository.snapshot(), {
    cases: 1,
    transitionFacts: 1,
    audits: 1,
    outbox: 1,
    idempotencyResults: 1,
  });

  const failed = createWorkflow({ completeAssessment: true });
  failed.repository.failOnceBeforeCommit();
  await assert.rejects(
    transition(failed.service, PRIMARY_ADVISOR, command({
      idempotencyKey: "case-transition-p1-14-007",
    })),
    /synthetic transaction failure/,
  );
  assert.deepEqual(failed.repository.caseState(CASE_ID), { stage: "signed", recordVersion: 1 });
  assert.deepEqual(failed.repository.snapshot(), {
    cases: 1,
    transitionFacts: 0,
    audits: 0,
    outbox: 0,
    idempotencyResults: 0,
  });
});

function caseTransitionError(code: string) {
  return (error: unknown) => error instanceof CaseTransitionError && error.code === code;
}

function sequenceIds(start: number): () => string {
  let current = start;
  return () => {
    current += 1;
    return `00000000-0000-4000-8000-${String(current).padStart(12, "0")}`;
  };
}
