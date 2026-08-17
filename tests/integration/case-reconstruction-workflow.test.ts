import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ReconstructionError,
  type ReconstructionEventInput,
} from "../../modules/cases/domain/reconstruction/contract.ts";
import { CaseReconstructionService } from "../../modules/cases/application/reconstruction/service.ts";
import { FakeCaseReconstructionRepository } from "../fakes/case-reconstruction.ts";

const NOW = "2026-08-12T00:30:00.000Z";
const reconstructionMigrationUrl = new URL("../../db/migrations/202608120030_015_expand_case_reconstruction.sql", import.meta.url);

function harness() {
  const repository = new FakeCaseReconstructionRepository();
  const service = new CaseReconstructionService({ repository, clock: { now: () => new Date(NOW) } });
  return { repository, service };
}

function event(overrides: Partial<ReconstructionEventInput> = {}): ReconstructionEventInput {
  return {
    eventType: "service_case.stage_changed.v1",
    occurredAt: "2026-08-01T00:00:00.000Z",
    sequenceNo: 1,
    evidenceType: "customer_record",
    evidenceRef: "evidence-01",
    reportedActorRef: "reported-actor-01",
    ...overrides,
  };
}

async function draftWithEvent() {
  const { repository, service } = harness();
  const draft = await service.createDraft({ actor: repository.advisor, command: repository.command("create-1") });
  const recorded = await service.recordEvent({
    actor: repository.advisor,
    reconstructionId: draft.reconstruction.id,
    command: { ...repository.baseCommand("event-1", draft.reconstruction.recordVersion), event: event() },
  });
  return { repository, service, result: recorded };
}

async function approvedVersion() {
  const setup = await draftWithEvent();
  const submitted = await setup.service.submit({
    actor: setup.repository.advisor,
    reconstructionId: setup.result.reconstruction.id,
    command: setup.repository.baseCommand("submit-1", setup.result.reconstruction.recordVersion),
  });
  const approved = await setup.service.approve({
    actor: setup.repository.founder,
    reconstructionId: submitted.reconstruction.id,
    command: setup.repository.baseCommand("approve-1", submitted.reconstruction.recordVersion),
  });
  return { ...setup, result: approved };
}

function binding(repository: FakeCaseReconstructionRepository) {
  return { organizationId: repository.advisor.organizationId, serviceCaseId: repository.serviceCaseId };
}

test("create is pre-activation and keyed by opaque pilot reference, not a ServiceCase", async () => {
  const { repository, service } = harness();
  const created = await service.createDraft({ actor: repository.advisor, command: repository.command("pre-case") });

  assert.equal(created.reconstruction.serviceCaseId, null);
  assert.equal(created.version.serviceCaseId, null);
  assert.equal(created.reconstruction.pilotReference, "pilot-ref-01");
  assert.equal(created.reconstruction.currentVersionId, created.version.id);
  assert.equal(created.metadata.outcome, "committed");
});

test("assigned Advisor and approved pilot are verified by the repository", async () => {
  const { repository, service } = harness();
  await assert.rejects(
    service.createDraft({ actor: repository.advisor, command: repository.command("pilot-denied", { pilotReference: "not-approved" }) }),
    (error: unknown) => error instanceof ReconstructionError && error.code === "RECONSTRUCTION_PILOT_NOT_APPROVED",
  );
  repository.assignedAdvisorByPilot.clear();
  await assert.rejects(
    service.createDraft({ actor: repository.advisor, command: repository.command("assignment-denied") }),
    (error: unknown) => error instanceof ReconstructionError && error.code === "RECONSTRUCTION_NOT_ASSIGNED",
  );
});

test("server time, opaque evidence and immutable event ordering are enforced", async () => {
  const { repository, service } = harness();
  const draft = await service.createDraft({ actor: repository.advisor, command: repository.command("invalid-create") });
  const cases = [
    { event: event({ occurredAt: "2026-08-13T00:00:00.000Z" }), code: "RECONSTRUCTION_OCCURRED_AT_FUTURE" },
    { event: event({ sequenceNo: 0 }), code: "RECONSTRUCTION_ORDER_INVALID" },
    { event: event({ evidenceRef: "a free text body" }), code: "RECONSTRUCTION_EVIDENCE_INVALID" },
  ] as const;
  for (const [index, item] of cases.entries()) {
    await assert.rejects(
      service.recordEvent({ actor: repository.advisor, reconstructionId: draft.reconstruction.id, command: { ...repository.baseCommand(`invalid-${index}`, 1), event: item.event } }),
      (error: unknown) => error instanceof ReconstructionError && error.code === item.code,
    );
  }
});

test("Founder reviewer must differ from the recorder", async () => {
  const { repository, service, result } = await draftWithEvent();
  const submitted = await service.submit({ actor: repository.advisor, reconstructionId: result.reconstruction.id, command: repository.baseCommand("self-submit", result.reconstruction.recordVersion) });
  const selfFounder = { ...repository.founder, userId: repository.advisor.userId };
  await assert.rejects(
    service.approve({ actor: selfFounder, reconstructionId: submitted.reconstruction.id, command: repository.baseCommand("self-approve", submitted.reconstruction.recordVersion) }),
    (error: unknown) => error instanceof ReconstructionError && error.code === "RECONSTRUCTION_REVIEWER_IS_RECORDER",
  );
});

test("next draft keeps the aggregate id, creates a distinct version id and leaves old versions readable/frozen", async () => {
  const { repository, service, result: initial } = await draftWithEvent();
  const aggregateId = initial.reconstruction.id;
  const firstVersionId = initial.version.id;
  const submitted = await service.submit({ actor: repository.advisor, reconstructionId: aggregateId, command: repository.baseCommand("revision-submit", initial.reconstruction.recordVersion) });
  const requested = await service.requestChanges({ actor: repository.founder, reconstructionId: aggregateId, command: repository.baseCommand("revision-request", submitted.reconstruction.recordVersion) });
  const next = await service.createNextDraft({ actor: repository.advisor, reconstructionId: aggregateId, command: repository.baseCommand("revision-next", requested.reconstruction.recordVersion) });

  assert.equal(next.reconstruction.id, aggregateId);
  assert.equal(next.reconstruction.currentVersionId, next.version.id);
  assert.notEqual(next.version.id, firstVersionId);
  assert.equal(next.version.versionNo, 2);
  assert.equal(next.versions.length, 2);
  assert.equal(repository.getVersion(aggregateId, firstVersionId)?.version.state, "changes_requested");
  assert.equal(repository.getVersion(aggregateId, firstVersionId)?.events[0]?.reconstructionVersionId, firstVersionId);
  assert.equal(repository.getVersion(aggregateId, firstVersionId)?.events[0]?.versionNo, 1);
});

test("activation fails closed without a case binding and atomically binds the real case to the approved version", async () => {
  const { repository, service, result } = await approvedVersion();
  await assert.rejects(
    service.activate({ actor: repository.founder, reconstructionId: result.reconstruction.id, command: repository.baseCommand("activation-missing-case", result.reconstruction.recordVersion) }),
    (error: unknown) => error instanceof ReconstructionError && error.code === "RECONSTRUCTION_SERVICE_CASE_BINDING_REQUIRED",
  );
  assert.equal(repository.get(result.reconstruction.id)?.reconstruction.serviceCaseId, null);
  assert.equal(repository.outboxMessages.length, 0);

  const activated = await service.activate({
    actor: repository.founder,
    reconstructionId: result.reconstruction.id,
    command: repository.baseCommand("activation-bound", result.reconstruction.recordVersion),
    serviceCaseBinding: binding(repository),
  });
  assert.equal(activated.reconstruction.state, "activated");
  assert.equal(activated.reconstruction.serviceCaseId, repository.serviceCaseId);
  assert.equal(activated.reconstruction.activatedVersionId, result.version.id);
  assert.equal(activated.version.id, result.version.id);
  assert.equal(activated.version.state, "approved", "approved revision remains frozen; aggregate carries activation state");
  assert.equal(repository.committedFacts.length, 1);
  assert.equal(repository.auditEvents.length, 1);
  assert.equal(repository.outboxMessages.length, 1);
});

test("activation rejects an absent or cross-tenant ServiceCase binding", async () => {
  const { repository, service, result } = await approvedVersion();
  await assert.rejects(
    service.activate({
      actor: repository.founder,
      reconstructionId: result.reconstruction.id,
      command: repository.baseCommand("activation-unknown-case", result.reconstruction.recordVersion),
      serviceCaseBinding: { organizationId: repository.advisor.organizationId, serviceCaseId: repository.otherServiceCaseId },
    }),
    (error: unknown) => error instanceof ReconstructionError && error.code === "RECONSTRUCTION_SERVICE_CASE_NOT_FOUND",
  );
  await assert.rejects(
    service.activate({
      actor: repository.founder,
      reconstructionId: result.reconstruction.id,
      command: repository.baseCommand("activation-other-tenant", result.reconstruction.recordVersion),
      serviceCaseBinding: { organizationId: "10000000-0000-4000-8000-000000000002", serviceCaseId: repository.serviceCaseId },
    }),
    (error: unknown) => error instanceof ReconstructionError && error.code === "RECONSTRUCTION_INVALID_INPUT",
  );
});

test("idempotency excludes request metadata but prevents cross-operation, actor and target aliasing", async () => {
  const { repository, service, result } = await approvedVersion();
  const command = repository.baseCommand("first-request", result.reconstruction.recordVersion);
  const first = await service.activate({ actor: repository.founder, reconstructionId: result.reconstruction.id, command, serviceCaseBinding: binding(repository) });
  const replay = await service.activate({
    actor: repository.founder,
    reconstructionId: result.reconstruction.id,
    command: { ...command, requestId: "different-request-id" },
    serviceCaseBinding: binding(repository),
  });
  assert.equal(replay.metadata.outcome, "replayed");
  assert.deepEqual(replay.reconstruction, first.reconstruction);
  assert.deepEqual(replay.version, first.version);
  assert.deepEqual(replay.events, first.events);
  assert.deepEqual(replay.gaps, first.gaps);
  assert.equal(repository.outboxMessages.length, 1);

  const otherFounder = { ...repository.founder, userId: "30000000-0000-4000-8000-000000000003" };
  await assert.rejects(
    service.activate({ actor: otherFounder, reconstructionId: result.reconstruction.id, command: { ...command, requestId: "actor-alias" }, serviceCaseBinding: binding(repository) }),
    (error: unknown) => error instanceof ReconstructionError && error.code === "RECONSTRUCTION_IDEMPOTENCY_KEY_REUSED",
  );

  repository.approvedPilotReferences.add("pilot-ref-02");
  repository.assignedAdvisorByPilot.set(`${repository.advisor.organizationId}:pilot-ref-02`, repository.advisor.userId);
  await assert.rejects(
    service.createDraft({ actor: repository.advisor, command: repository.command("target-alias", { pilotReference: "pilot-ref-02", idempotencyKey: command.idempotencyKey }) }),
    (error: unknown) => error instanceof ReconstructionError && error.code === "RECONSTRUCTION_IDEMPOTENCY_KEY_REUSED",
  );
});

test("in-progress and uncertain commits are fail-closed and never blindly replayed", async () => {
  const { repository, service } = harness();
  const blocked = repository.command("in-progress");
  repository.inProgressIdempotencyKeys.add(blocked.idempotencyKey);
  await assert.rejects(
    service.createDraft({ actor: repository.advisor, command: blocked }),
    (error: unknown) => error instanceof ReconstructionError && error.code === "RECONSTRUCTION_IDEMPOTENCY_IN_PROGRESS" && error.retryable === false && error.httpStatus === 409,
  );

  const setup = await approvedVersion();
  setup.repository.uncertainAfterCommit = true;
  const command = setup.repository.baseCommand("unknown-commit", setup.result.reconstruction.recordVersion);
  await assert.rejects(
    setup.service.activate({ actor: setup.repository.founder, reconstructionId: setup.result.reconstruction.id, command, serviceCaseBinding: binding(setup.repository) }),
    (error: unknown) => error instanceof ReconstructionError && error.code === "RECONSTRUCTION_COMMIT_OUTCOME_UNKNOWN" && error.retryable === false && error.httpStatus === 503,
  );
  assert.equal(setup.repository.idempotencyReceipts.get(command.idempotencyKey)?.state, "failed_reconcilable");
  assert.equal(setup.repository.outboxMessages.length, 1, "commit uncertainty does not justify a second effect");
  await assert.rejects(
    setup.service.activate({ actor: setup.repository.founder, reconstructionId: setup.result.reconstruction.id, command, serviceCaseBinding: binding(setup.repository) }),
    (error: unknown) => error instanceof ReconstructionError && error.code === "RECONSTRUCTION_COMMIT_OUTCOME_UNKNOWN",
  );
  assert.equal(setup.repository.reconcile(command.idempotencyKey)?.reconstruction.state, "activated");
});

test("correction appends immutable metadata, preserves the original and rejects correction-of-correction", async () => {
  const { repository, service, result } = await approvedVersion();
  const activated = await service.activate({ actor: repository.founder, reconstructionId: result.reconstruction.id, command: repository.baseCommand("correction-activate", result.reconstruction.recordVersion), serviceCaseBinding: binding(repository) });
  const original = structuredClone(activated.events[0]);
  const corrected = await service.appendCorrection({
    actor: repository.advisor,
    reconstructionId: activated.reconstruction.id,
    command: {
      ...repository.baseCommand("correction-1", activated.reconstruction.recordVersion),
      correctionOfEventId: activated.events[0]!.id,
      reasonCode: "SOURCE_CONFLICT",
      event: event({ eventType: "school_target.state_changed.v1", occurredAt: "2026-08-02T00:00:00.000Z", evidenceRef: "evidence-correction" }),
    },
  });
  const correction = corrected.events.at(-1)!;
  assert.deepEqual(corrected.events[0], original);
  assert.equal(correction.correctionOfEventId, original!.id);
  assert.equal(correction.correctionReasonCode, "SOURCE_CONFLICT");
  assert.equal(correction.correctedByUserId, repository.advisor.userId);
  assert.equal(correction.recorderUserId, repository.advisor.userId);
  assert.equal(correction.reconstructionVersionId, activated.version.id);
  assert.equal(correction.versionNo, activated.version.versionNo);
  assert.equal(correction.expectedRecordVersion, activated.reconstruction.recordVersion);
  assert.equal((repository.auditEvents.at(-1) as { eventType: string }).eventType, "case_reconstruction.corrected.v1");

  await assert.rejects(
    service.appendCorrection({
      actor: repository.advisor,
      reconstructionId: activated.reconstruction.id,
      command: {
        ...repository.baseCommand("correction-chain", corrected.reconstruction.recordVersion),
        correctionOfEventId: correction.id,
        reasonCode: "SOURCE_UNAVAILABLE",
        event: event({ evidenceRef: "evidence-chain" }),
      },
    }),
    (error: unknown) => error instanceof ReconstructionError && error.code === "RECONSTRUCTION_CORRECTION_OF_CORRECTION",
  );
});

test("correction schema fails closed when the target event is from a non-activated version", async () => {
  const sql = await readFile(reconstructionMigrationUrl, "utf8");
  assert.match(sql, /target_version_id IS DISTINCT FROM parent_activated_version_id/);
  assert.match(sql, /CONSTRAINT = 'cases_reconstruction_correction_target_activated_version'/);
});

test("activation rollback leaves every effect and receipt absent when commit fails before commit", async () => {
  const { repository, service, result } = await approvedVersion();
  repository.failBeforeCommit = true;
  const command = repository.baseCommand("activation-fail", result.reconstruction.recordVersion);
  await assert.rejects(service.activate({ actor: repository.founder, reconstructionId: result.reconstruction.id, command, serviceCaseBinding: binding(repository) }), /FAKE_FAIL_BEFORE_COMMIT/);
  assert.equal(repository.get(result.reconstruction.id)?.reconstruction.state, "approved");
  assert.deepEqual([repository.committedFacts.length, repository.committedHistory.length, repository.committedGaps.length, repository.auditEvents.length, repository.outboxMessages.length], [0, 0, 0, 0, 0]);
  assert.equal(repository.idempotencyReceipts.has(command.idempotencyKey), false);
});
