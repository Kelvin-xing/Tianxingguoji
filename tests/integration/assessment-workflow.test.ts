import assert from "node:assert/strict";
import test from "node:test";

import { composeK12Manifest, type K12Module } from "../../modules/cases/domain/contract.ts";
import {
  AssessmentService,
  AssessmentServiceError,
} from "../../modules/cases/application/assessment-service.ts";
import { InMemoryAssessmentRepository } from "../fakes/assessment.ts";

const ADVISOR = Object.freeze({
  userId: "11111111-1111-4111-8111-111111111111",
  organizationId: "22222222-2222-4222-8222-222222222222",
  role: "advisor" as const,
  sessionId: "33333333-3333-4333-8333-333333333333",
  capturedSessionVersion: 1,
  reauthenticatedAtMs: 1_754_265_600_000,
});
const COLLABORATOR = Object.freeze({
  ...ADVISOR,
  userId: "44444444-4444-4444-8444-444444444444",
  sessionId: "55555555-5555-4555-8555-555555555555",
});
const CONTRACTOR = Object.freeze({
  ...ADVISOR,
  role: "contractor" as const,
  userId: "99999999-9999-4999-8999-999999999999",
  sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
});
const CASE_ID = "66666666-6666-4666-8666-666666666666";
const ASSESSMENT_ID = "77777777-7777-4777-8777-777777777777";
const MANIFEST_ID = "88888888-8888-4888-8888-888888888888";

class FixedClock {
  nowMs(): number {
    return 1_754_265_600_000;
  }
}

function createWorkflow() {
  const repository = new InMemoryAssessmentRepository({
    assessmentId: ASSESSMENT_ID,
    caseId: CASE_ID,
    organizationId: ADVISOR.organizationId,
    manifestId: MANIFEST_ID,
    manifest: fixtureManifest(),
  });
  repository.assignPrimaryAdvisor({
    organizationId: ADVISOR.organizationId,
    caseId: CASE_ID,
    userId: ADVISOR.userId,
  });
  const service = new AssessmentService({
    repository,
    clock: new FixedClock(),
    createId: sequenceIds(100),
  });
  return { repository, service };
}

function command(overrides: Partial<{
  readonly fieldId: string;
  readonly semanticState: "provided" | "unknown" | "not_applicable" | "declined_to_provide";
  readonly value: unknown;
  readonly valueType: string | null;
  readonly expectedRecordVersion: number;
  readonly idempotencyKey: string;
}> = {}) {
  return {
    fieldId: "fixture.base.intent",
    semanticState: "provided" as const,
    value: { type: "text", value: "S1 entry" },
    valueType: "text",
    expectedRecordVersion: 0,
    requestId: "assessment.update",
    idempotencyKey: "assessment-update-001",
    ...overrides,
  };
}

test("resolves one serializable four-layer schema for the assessment read model", async () => {
  const { service } = createWorkflow();

  const view = await service.getCaseAssessment({ actor: ADVISOR, caseId: CASE_ID });

  assert.deepEqual(view.schema, {
    manifestId: MANIFEST_ID,
    compositionVersion: "k12-structural-v1",
    fields: [
      {
        fieldId: "fixture.base.intent",
        layer: "base",
        valueType: "text" as const,
        visibility: "case",
        blockingStages: ["background_collection"],
      },
      {
        fieldId: "fixture.stage.year",
        layer: "education_stage",
        valueType: "text",
        visibility: "case",
        blockingStages: [],
      },
      {
        fieldId: "fixture.system.preference",
        layer: "school_system",
        valueType: "text",
        visibility: "case",
        blockingStages: ["school_selection_confirmed"],
      },
      {
        fieldId: "fixture.route.entry",
        layer: "admission_route",
        valueType: "text",
        visibility: "case",
        blockingStages: [],
      },
    ],
  });
  assert.deepEqual(view.answers, []);
  assert.equal(view.assessmentId, ASSESSMENT_ID);
  assert.equal(view.recordVersion, 1);
});

test("updates one typed answer atomically and exposes the same answer through the read model", async () => {
  const { repository, service } = createWorkflow();

  const result = await service.updateAssessmentAnswer({
    actor: ADVISOR,
    caseId: CASE_ID,
    command: command(),
  });

  assert.deepEqual(result, {
    assessmentId: ASSESSMENT_ID,
    fieldId: "fixture.base.intent",
    semanticState: "provided",
    value: { type: "text", value: "S1 entry" },
    valueType: "text",
    recordVersion: 1,
  });
  assert.deepEqual(repository.snapshot(), { answers: 1, audits: 1, outbox: 1 });

  const view = await service.getCaseAssessment({ actor: ADVISOR, caseId: CASE_ID });
  assert.deepEqual(view.answers, [
    {
      fieldId: "fixture.base.intent",
      semanticState: "provided",
      value: { type: "text", value: "S1 entry" },
      valueType: "text",
      recordVersion: 1,
    },
  ]);
});

test("accepts explicit non-value semantic states without converting them to empty text", async () => {
  const { service } = createWorkflow();

  const result = await service.updateAssessmentAnswer({
    actor: ADVISOR,
    caseId: CASE_ID,
    command: command({
      semanticState: "declined_to_provide",
      value: null,
      valueType: null,
    }),
  });

  assert.deepEqual(result, {
    assessmentId: ASSESSMENT_ID,
    fieldId: "fixture.base.intent",
    semanticState: "declined_to_provide",
    value: null,
    valueType: null,
    recordVersion: 1,
  });
});

test("uses the answer version as a compare-and-set token instead of last-write-wins", async () => {
  const { repository, service } = createWorkflow();
  await service.updateAssessmentAnswer({ actor: ADVISOR, caseId: CASE_ID, command: command() });

  await assert.rejects(
    service.updateAssessmentAnswer({
      actor: ADVISOR,
      caseId: CASE_ID,
      command: command({
        value: { type: "text", value: "stale draft" },
        idempotencyKey: "assessment-update-002",
      }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof AssessmentServiceError);
      assert.equal(error.code, "ASSESSMENT_ANSWER_STALE_VERSION");
      assert.equal(error.currentRecordVersion, 1);
      assert.match(error.diffToken ?? "", /^assessment-[A-Za-z0-9._-]+$/);
      return true;
    },
  );
  assert.deepEqual(repository.snapshot(), { answers: 1, audits: 1, outbox: 1 });
});

test("permits current education-profile capabilities and rejects invalid fields and type mismatches", async () => {
  const { repository, service } = createWorkflow();
  repository.grantEducationProfileView({
    organizationId: ADVISOR.organizationId,
    caseId: CASE_ID,
    userId: COLLABORATOR.userId,
  });
  await service.getCaseAssessment({ actor: COLLABORATOR, caseId: CASE_ID });
  await assert.rejects(
    service.updateAssessmentAnswer({ actor: COLLABORATOR, caseId: CASE_ID, command: command() }),
    hasCode("ASSESSMENT_WRITE_FORBIDDEN"),
  );
  repository.grantEducationProfileEdit({
    organizationId: ADVISOR.organizationId,
    caseId: CASE_ID,
    userId: COLLABORATOR.userId,
  });

  await service.updateAssessmentAnswer({ actor: COLLABORATOR, caseId: CASE_ID, command: command() });
  await assert.rejects(
    service.updateAssessmentAnswer({
      actor: ADVISOR,
      caseId: CASE_ID,
      command: command({
        fieldId: "fixture.unknown",
        idempotencyKey: "assessment-update-003",
      }),
    }),
    hasCode("ASSESSMENT_ANSWER_INVALID"),
  );
  await assert.rejects(
    service.updateAssessmentAnswer({
      actor: ADVISOR,
      caseId: CASE_ID,
      command: command({
        value: { type: "number", value: 1 },
        valueType: "number",
        idempotencyKey: "assessment-update-004",
      }),
    }),
    hasCode("ASSESSMENT_ANSWER_INVALID"),
  );
});

test("idempotency replay has no second effect and a transaction failure leaves no answer or effect", async () => {
  const { repository, service } = createWorkflow();
  const first = await service.updateAssessmentAnswer({ actor: ADVISOR, caseId: CASE_ID, command: command() });
  const replay = await service.updateAssessmentAnswer({ actor: ADVISOR, caseId: CASE_ID, command: command() });
  assert.deepEqual(replay, first);
  assert.deepEqual(repository.snapshot(), { answers: 1, audits: 1, outbox: 1 });

  const failed = createWorkflow();
  failed.repository.failOnceBeforeCommit();
  await assert.rejects(
    failed.service.updateAssessmentAnswer({ actor: ADVISOR, caseId: CASE_ID, command: command() }),
    /synthetic transaction failure/,
  );
  assert.deepEqual(failed.repository.snapshot(), { answers: 0, audits: 0, outbox: 0 });
});

test("completes background collection only after every background blocker has an explicit answer", async () => {
  const { repository, service } = createWorkflow();
  await assert.rejects(
    service.completeBackgroundCollection({
      actor: ADVISOR,
      caseId: CASE_ID,
      command: {
        expectedRecordVersion: 1,
        requestId: "assessment.complete",
        idempotencyKey: "assessment-complete-001",
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AssessmentServiceError);
      assert.equal(error.code, "ASSESSMENT_STATUS_BLOCKERS_INCOMPLETE");
      assert.deepEqual(error.missingFieldIds, ["fixture.base.intent"]);
      return true;
    },
  );
  assert.deepEqual(repository.snapshot(), { answers: 0, audits: 0, outbox: 0 });

  await service.updateAssessmentAnswer({
    actor: ADVISOR,
    caseId: CASE_ID,
    command: command({
      semanticState: "unknown",
      value: null,
      valueType: null,
    }),
  });
  const completionCommand = {
    expectedRecordVersion: 1,
    requestId: "assessment.complete",
    idempotencyKey: "assessment-complete-002",
  };
  const completed = await service.completeBackgroundCollection({
    actor: ADVISOR,
    caseId: CASE_ID,
    command: completionCommand,
  });
  const replay = await service.completeBackgroundCollection({
    actor: ADVISOR,
    caseId: CASE_ID,
    command: completionCommand,
  });

  assert.deepEqual(completed, {
    assessmentId: ASSESSMENT_ID,
    status: "background_complete",
    recordVersion: 2,
  });
  assert.deepEqual(replay, completed);
  assert.deepEqual(repository.snapshot(), { answers: 1, audits: 2, outbox: 2 });
  assert.equal(
    (await service.getCaseAssessment({ actor: ADVISOR, caseId: CASE_ID })).status,
    "background_complete",
  );
});

test("rejects assessment reads and writes for roles outside the internal assessment boundary", async () => {
  const { service } = createWorkflow();
  await assert.rejects(
    service.getCaseAssessment({ actor: CONTRACTOR, caseId: CASE_ID }),
    hasCode("ASSESSMENT_READ_FORBIDDEN"),
  );
  await assert.rejects(
    service.updateAssessmentAnswer({ actor: CONTRACTOR, caseId: CASE_ID, command: command() }),
    hasCode("ASSESSMENT_WRITE_FORBIDDEN"),
  );
});

function fixtureManifest() {
  return composeK12Manifest([
    module("base", "base", "fixture.base.intent", ["background_collection"]),
    module("education_stage", "stage", "fixture.stage.year", []),
    module("school_system", "system", "fixture.system.preference", ["school_selection_confirmed"]),
    module("admission_route", "route", "fixture.route.entry", []),
  ]);
}

function module(
  layer: "base" | "education_stage" | "school_system" | "admission_route",
  moduleId: string,
  fieldId: string,
  blockingStages: readonly string[],
): K12Module {
  return {
    applicationType: "k12" as const,
    layer,
    moduleId,
    version: "synthetic-v1",
    catalogueStatus: "synthetic_candidate" as const,
    productionEnabled: false as const,
    fields: [
      {
        fieldId,
        valueType: "text",
        visibility: "case",
        blockingStages,
      },
    ],
  };
}

function hasCode(code: string) {
  return (error: unknown) => error instanceof AssessmentServiceError && error.code === code;
}

function sequenceIds(start: number): () => string {
  let current = start;
  return () => {
    current += 1;
    return `00000000-0000-4000-8000-${String(current).padStart(12, "0")}`;
  };
}
