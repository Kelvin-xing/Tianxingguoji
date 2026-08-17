import assert from "node:assert/strict";
import test from "node:test";

import { CaseCreationError, CaseService } from "../../modules/cases/application/service.ts";
import { InMemoryCaseCreationRepository } from "../fakes/case-creation.ts";

const ADVISOR = Object.freeze({
  userId: "11111111-1111-4111-8111-111111111111",
  organizationId: "22222222-2222-4222-8222-222222222222",
  role: "advisor" as const,
  sessionId: "33333333-3333-4333-8333-333333333333",
  capturedSessionVersion: 1,
  reauthenticatedAtMs: 1_754_265_600_000,
});
const MANIFEST_ID = "44444444-4444-4444-8444-444444444444";

class FixedClock {
  nowMs(): number {
    return 1_754_265_600_000;
  }
}

function createWorkflow() {
  const repository = new InMemoryCaseCreationRepository();
  repository.activateAdvisor({ organizationId: ADVISOR.organizationId, userId: ADVISOR.userId });
  repository.approveManifest(MANIFEST_ID);
  const service = new CaseService({
    repository,
    clock: new FixedClock(),
    createId: sequenceIds(100),
  });
  return { repository, service };
}

function command(overrides: Partial<{
  readonly idempotencyKey: string;
  readonly caseNumber: string;
  readonly schemaManifestId: string;
  readonly admissionType: string;
}> = {}) {
  return {
    student: {
      displayName: "Synthetic Student",
      dateOfBirth: "2014-09-01",
      contactEmail: null,
      contactPhone: null,
    },
    intakeYear: 2027,
    admissionType: "s1",
    caseNumber: "case-p1-05-001",
    schemaManifestId: MANIFEST_ID,
    requestId: "request-p1-05-001",
    idempotencyKey: "case-create-p1-05-001",
    ...overrides,
  } as const;
}

test("an Advisor atomically creates Student, signed K12 Case, assessment, audit, and outbox", async () => {
  const { repository, service } = createWorkflow();

  const result = await service.createAdvisorK12Case({ actor: ADVISOR, command: command() });

  assert.deepEqual(result, {
    studentId: "00000000-0000-4000-8000-000000000101",
    serviceCaseId: "00000000-0000-4000-8000-000000000102",
    assessmentId: "00000000-0000-4000-8000-000000000103",
    primaryAdvisorUserId: ADVISOR.userId,
    stage: "signed",
    recordVersion: 1,
  });
  assert.deepEqual(repository.snapshot(), {
    students: 1,
    cases: 1,
    assessments: 1,
    audits: 1,
    outbox: 1,
  });
});

test("the same idempotency key returns the first result without a second transaction effect", async () => {
  const { repository, service } = createWorkflow();
  const first = await service.createAdvisorK12Case({ actor: ADVISOR, command: command() });
  const replay = await service.createAdvisorK12Case({ actor: ADVISOR, command: command() });

  assert.deepEqual(replay, first);
  assert.deepEqual(repository.snapshot(), {
    students: 1,
    cases: 1,
    assessments: 1,
    audits: 1,
    outbox: 1,
  });
});

test("idempotency reuse and a second active case each fail closed", async () => {
  const { repository, service } = createWorkflow();
  const first = await service.createAdvisorK12Case({ actor: ADVISOR, command: command() });

  await assert.rejects(
    service.createAdvisorK12Case({
      actor: ADVISOR,
      command: command({ caseNumber: "case-p1-05-altered" }),
    }),
    hasCaseCode("CASE_CREATION_IDEMPOTENCY_KEY_REUSED"),
  );
  await assert.rejects(
    new CaseService({
      repository,
      clock: new FixedClock(),
      createId: ids([
        first.studentId,
        "00000000-0000-4000-8000-000000000702",
        "00000000-0000-4000-8000-000000000703",
        "00000000-0000-4000-8000-000000000704",
        "00000000-0000-4000-8000-000000000705",
      ]),
    }).createAdvisorK12Case({
      actor: ADVISOR,
      command: command({
        idempotencyKey: "case-create-p1-05-002",
        caseNumber: "case-p1-05-002",
      }),
    }),
    hasCaseCode("CASE_CREATION_ACTIVE_DUPLICATE"),
  );
});

test("inactive Advisor binding, unapproved manifest, and non-Advisor actor are denied", async () => {
  const { repository, service } = createWorkflow();
  const inactiveRepository = new InMemoryCaseCreationRepository();
  inactiveRepository.approveManifest(MANIFEST_ID);
  const inactiveService = new CaseService({
    repository: inactiveRepository,
    clock: new FixedClock(),
    createId: sequenceIds(200),
  });
  await assert.rejects(
    inactiveService.createAdvisorK12Case({ actor: ADVISOR, command: command() }),
    hasCaseCode("CASE_CREATION_PRIMARY_BINDING_INACTIVE"),
  );

  await assert.rejects(
    service.createAdvisorK12Case({
      actor: ADVISOR,
      command: command({ schemaManifestId: "55555555-5555-4555-8555-555555555555" }),
    }),
    hasCaseCode("CASE_CREATION_MANIFEST_NOT_APPROVED"),
  );
  await assert.rejects(
    service.createAdvisorK12Case({ actor: { ...ADVISOR, role: "founder" }, command: command() }),
    hasCaseCode("CASE_ADVISOR_REQUIRED"),
  );
  assert.equal(repository.snapshot().cases, 0);
});

test("a repository failure leaves no partial Student, Case, audit, or outbox state", async () => {
  const { repository, service } = createWorkflow();
  repository.failOnceBeforeCommit();

  await assert.rejects(
    service.createAdvisorK12Case({ actor: ADVISOR, command: command() }),
    /synthetic transaction failure/,
  );
  assert.deepEqual(repository.snapshot(), {
    students: 0,
    cases: 0,
    assessments: 0,
    audits: 0,
    outbox: 0,
  });
});

function hasCaseCode(code: string) {
  return (error: unknown) => error instanceof CaseCreationError && error.code === code;
}

function sequenceIds(start: number): () => string {
  let current = start;
  return () => {
    current += 1;
    return `00000000-0000-4000-8000-${String(current).padStart(12, "0")}`;
  };
}

function ids(values: readonly string[]): () => string {
  const remaining = [...values];
  return () => {
    const next = remaining.shift();
    if (!next) throw new Error("test id sequence exhausted");
    return next;
  };
}
