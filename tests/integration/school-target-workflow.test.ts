import assert from "node:assert/strict";
import test from "node:test";

import {
  approveSchoolOverlay,
  proposeSchoolOverlay,
  sha256SchoolValue,
  type SchoolBaseRecord,
  type SchoolOverlayRevision,
} from "../../modules/schools/domain/contract.ts";
import {
  resolveSchoolTargetView,
  ResolvedSchoolViewService,
  SchoolResolutionError,
} from "../../modules/schools/application/resolved-view.ts";
import {
  SchoolTargetError,
  SchoolTargetService,
} from "../../modules/cases/application/school-target-service.ts";
import { InMemorySchoolTargetRepository } from "../fakes/school-target.ts";

const ADVISOR = Object.freeze({
  userId: "11111111-1111-4111-8111-111111111111",
  organizationId: "22222222-2222-4222-8222-222222222222",
  role: "advisor" as const,
  sessionId: "33333333-3333-4333-8333-333333333333",
  capturedSessionVersion: 1,
  reauthenticatedAtMs: 1_754_265_600_000,
});
const FOUNDER = Object.freeze({
  userId: "44444444-4444-4444-8444-444444444444",
  organizationId: ADVISOR.organizationId,
  role: "founder" as const,
  sessionId: "55555555-5555-4555-8555-555555555555",
  capturedSessionVersion: 1,
  reauthenticatedAtMs: 1_754_265_600_000,
});
const SCHOOL_ID = "66666666-6666-4666-8666-666666666666";
const SNAPSHOT_ID = "77777777-7777-4777-8777-777777777777";
const CASE_ID = "88888888-8888-4888-8888-888888888888";
const OTHER_CASE_ID = "99999999-9999-4999-8999-999999999999";

class FixedClock {
  nowMs(): number {
    return 1_754_265_600_000;
  }
}

function baseRecord(): SchoolBaseRecord {
  return {
    organizationId: ADVISOR.organizationId,
    schoolId: SCHOOL_ID,
    snapshotId: SNAPSHOT_ID,
    sourceSchoolKey: "crawler-school-001",
    fields: {
      school_name_zh: "Original School",
      district: "Central",
      official_website: "https://example.test/original",
    },
  };
}

function approvedOverlay(input: {
  readonly revisionId: string;
  readonly revisionNumber: number;
  readonly value: string;
}): SchoolOverlayRevision {
  return approveSchoolOverlay(
    proposeSchoolOverlay({
      organizationId: ADVISOR.organizationId,
      schoolId: SCHOOL_ID,
      baseSnapshotId: SNAPSHOT_ID,
      revisionId: input.revisionId,
      revisionNumber: input.revisionNumber,
      requestedBy: ADVISOR.userId,
      reason: "Synthetic correction",
      changes: [
        {
          fieldName: "district",
          fieldClass: "general",
          proposedValue: input.value,
          baseValueSha256: sha256SchoolValue("Central"),
          evidence: {
            sourceUrl: "https://example.test/evidence/district",
            quote: `District: ${input.value}`,
          },
        },
      ],
      createdAt: "2026-08-07T00:00:00.000Z",
    }),
    {
      reviewerId: FOUNDER.userId,
      reviewerRole: "founder",
      approvedAt: "2026-08-07T00:05:00.000Z",
    },
  );
}

function setup(): InMemorySchoolTargetRepository {
  const repository = new InMemorySchoolTargetRepository();
  repository.activateUser({
    organizationId: ADVISOR.organizationId,
    userId: ADVISOR.userId,
    role: "advisor",
  });
  repository.activateUser({
    organizationId: FOUNDER.organizationId,
    userId: FOUNDER.userId,
    role: "founder",
  });
  repository.seedCase({
    caseId: CASE_ID,
    organizationId: ADVISOR.organizationId,
    primaryAdvisorUserId: ADVISOR.userId,
  });
  repository.seedBase(baseRecord());
  return repository;
}

function targetCommand(expectedResolutionSha256: string, overrides: Record<string, unknown> = {}) {
  return {
    expectedResolutionSha256,
    requestId: "request-p1-09-target-001",
    idempotencyKey: "school-target-p1-09-001",
    ...overrides,
  };
}

test("an approved active overlay creates one immutable candidate target", async () => {
  const repository = setup();
  const first = approvedOverlay({
    revisionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    revisionNumber: 1,
    value: "Eastern",
  });
  const candidate = proposeSchoolOverlay({
    organizationId: ADVISOR.organizationId,
    schoolId: SCHOOL_ID,
    baseSnapshotId: SNAPSHOT_ID,
    revisionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    revisionNumber: 2,
    requestedBy: ADVISOR.userId,
    reason: "Not approved",
    changes: [
      {
        fieldName: "district",
        fieldClass: "general",
        proposedValue: "Northern",
        baseValueSha256: sha256SchoolValue("Central"),
        evidence: { sourceUrl: "https://example.test/evidence/candidate", quote: "Northern" },
      },
    ],
    createdAt: "2026-08-07T00:10:00.000Z",
  });
  repository.seedOverlay({ revision: first });
  repository.seedOverlay({ revision: candidate });
  const expected = resolveSchoolTargetView({ base: baseRecord(), revisions: [first, candidate] });
  const service = new SchoolTargetService({
    repository,
    clock: new FixedClock(),
    createId: sequenceIds(100),
  });

  const result = await service.createSchoolTarget({
    actor: ADVISOR,
    caseId: CASE_ID,
    schoolId: SCHOOL_ID,
    command: targetCommand(expected.pin.resolutionSha256),
  });

  assert.equal(result.targetId, "00000000-0000-4000-8000-000000000101");
  assert.equal(result.state, "candidate");
  assert.equal(result.resolvedRevisionId, "00000000-0000-4000-8000-000000000102");
  assert.equal(result.resolutionSha256, expected.pin.resolutionSha256);
  assert.equal(result.schoolName, "Original School");
  assert.equal(result.intakeYear, 2027);
  assert.equal(result.admissionType, "hk_k12_standard_v1");
  assert.deepEqual(repository.snapshot(), {
    targets: 1,
    overlays: 2,
    resolvedRevisions: 1,
    audits: 1,
    outbox: 1,
    targetIdempotencyResults: 1,
    overlayIdempotencyResults: 0,
  });
  const effects = repository.effectsFor(result.targetId);
  assert.ok(effects);
  assert.doesNotMatch(JSON.stringify(effects), /Eastern|example\.test|Synthetic correction/i);
});

test("Founder and Primary Advisor read the frozen Slice 1 workspace without create options", async () => {
  const repository = setup();
  const service = new SchoolTargetService({ repository });

  const advisor = await service.getSchoolTargets({ actor: ADVISOR, caseId: CASE_ID });
  assert.equal(advisor.canCreate, false);
  assert.equal(advisor.createBlockedReason, "selection_workflow_required");
  assert.equal(advisor.intakeYear, 2027);
  assert.equal(advisor.admissionType, "hk_k12_standard_v1");
  assert.deepEqual(advisor.schoolOptions, []);

  const founder = await service.getSchoolTargets({ actor: FOUNDER, caseId: CASE_ID });
  assert.equal(founder.canCreate, false);
  assert.equal(founder.createBlockedReason, "selection_workflow_required");
  assert.deepEqual(founder.schoolOptions, []);
});

test("non-primary Advisor cannot read a case and non-target stages fail closed", async () => {
  const repository = setup();
  repository.seedCase({
    caseId: OTHER_CASE_ID,
    organizationId: ADVISOR.organizationId,
    primaryAdvisorUserId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  });
  repository.seedCase({
    caseId: CASE_ID,
    organizationId: ADVISOR.organizationId,
    primaryAdvisorUserId: ADVISOR.userId,
    stage: "signed",
    intakeYear: 2031,
    admissionType: "server_owned_route",
  });
  const service = new SchoolTargetService({ repository, clock: new FixedClock() });

  await assert.rejects(
    service.getSchoolTargets({ actor: ADVISOR, caseId: OTHER_CASE_ID }),
    targetError("SCHOOL_TARGET_CASE_NOT_FOUND"),
  );
  const workspace = await service.getSchoolTargets({ actor: ADVISOR, caseId: CASE_ID });
  assert.equal(workspace.canCreate, false);
  assert.equal(workspace.createBlockedReason, "selection_workflow_required");
  assert.deepEqual(workspace.schoolOptions, []);
  const expected = resolveSchoolTargetView({ base: baseRecord(), revisions: [] });
  await assert.rejects(
    service.createSchoolTarget({
      actor: ADVISOR,
      caseId: CASE_ID,
      schoolId: SCHOOL_ID,
      command: targetCommand(expected.pin.resolutionSha256),
    }),
    targetError("SCHOOL_TARGET_STAGE_NOT_ALLOWED"),
  );
  assert.equal(repository.snapshot().targets, 0);
});

test("a target pointer based on an older resolved hash fails with a stale conflict", async () => {
  const repository = setup();
  const first = approvedOverlay({
    revisionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    revisionNumber: 1,
    value: "Eastern",
  });
  repository.seedOverlay({ revision: first });
  const stale = resolveSchoolTargetView({ base: baseRecord(), revisions: [first] });
  const second = approvedOverlay({
    revisionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    revisionNumber: 2,
    value: "Northern",
  });
  repository.seedOverlay({ revision: second });
  const service = new SchoolTargetService({ repository, clock: new FixedClock(), createId: sequenceIds(200) });

  await assert.rejects(
    service.createSchoolTarget({
      actor: ADVISOR,
      caseId: CASE_ID,
      schoolId: SCHOOL_ID,
      command: targetCommand(stale.pin.resolutionSha256),
    }),
    targetError("SCHOOL_TARGET_RESOLUTION_STALE"),
  );
  assert.deepEqual(repository.snapshot(), {
    targets: 0,
    overlays: 2,
    resolvedRevisions: 0,
    audits: 0,
    outbox: 0,
    targetIdempotencyResults: 0,
    overlayIdempotencyResults: 0,
  });
});

test("disabling an approved revision creates a rollback view without rewriting an existing pin", async () => {
  const repository = setup();
  const first = approvedOverlay({
    revisionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    revisionNumber: 1,
    value: "Eastern",
  });
  const second = approvedOverlay({
    revisionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    revisionNumber: 2,
    value: "Northern",
  });
  repository.seedOverlay({ revision: first });
  repository.seedOverlay({ revision: second });
  const current = resolveSchoolTargetView({ base: baseRecord(), revisions: [first, second] });
  const targetService = new SchoolTargetService({
    repository,
    clock: new FixedClock(),
    createId: sequenceIds(300),
  });
  const target = await targetService.createSchoolTarget({
    actor: ADVISOR,
    caseId: CASE_ID,
    schoolId: SCHOOL_ID,
    command: targetCommand(current.pin.resolutionSha256),
  });
  const resolutionService = new ResolvedSchoolViewService({
    repository,
    clock: new FixedClock(),
    createId: sequenceIds(400),
  });

  await assert.rejects(
    resolutionService.disableApprovedOverlay({
      actor: FOUNDER,
      schoolId: SCHOOL_ID,
      overlayRevisionId: second.revisionId,
      command: {
        expectedRecordVersion: 2,
        reason: "Incorrect source",
        requestId: "request-p1-09-disable-stale",
        idempotencyKey: "school-overlay-disable-p1-09-stale",
      },
    }),
    resolutionError("SCHOOL_OVERLAY_STALE_VERSION"),
  );
  const disabled = await resolutionService.disableApprovedOverlay({
    actor: FOUNDER,
    schoolId: SCHOOL_ID,
    overlayRevisionId: second.revisionId,
    command: {
      expectedRecordVersion: 1,
      reason: "Incorrect source",
      requestId: "request-p1-09-disable-001",
      idempotencyKey: "school-overlay-disable-p1-09-001",
    },
  });

  const expectedRollback = resolveSchoolTargetView({ base: baseRecord(), revisions: [first] });
  assert.equal(disabled.recordVersion, 2);
  assert.match(
    disabled.rollback.pin.resolvedRevisionId ?? "",
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  assert.notEqual(disabled.rollback.pin.resolvedRevisionId, target.resolvedRevisionId);
  assert.equal(disabled.rollback.pin.resolutionSha256, expectedRollback.pin.resolutionSha256);
  assert.equal(disabled.rollback.pin.overlayRevisionId, first.revisionId);
  assert.deepEqual(disabled.rollback.pin.provenance, expectedRollback.pin.provenance);
  assert.equal(repository.overlay(second.revisionId)?.revision.status, "disabled");
  assert.equal(repository.overlay(first.revisionId)?.revision.status, "approved");
  assert.equal(repository.target(target.targetId)?.resolutionSha256, current.pin.resolutionSha256);
  assert.deepEqual(
    await resolutionService.disableApprovedOverlay({
      actor: FOUNDER,
      schoolId: SCHOOL_ID,
      overlayRevisionId: second.revisionId,
      command: {
        expectedRecordVersion: 1,
        reason: "Incorrect source",
        requestId: "request-p1-09-disable-001",
        idempotencyKey: "school-overlay-disable-p1-09-001",
      },
    }),
    disabled,
  );
  assert.deepEqual(repository.snapshot(), {
    targets: 1,
    overlays: 2,
    resolvedRevisions: 2,
    audits: 2,
    outbox: 2,
    targetIdempotencyResults: 1,
    overlayIdempotencyResults: 1,
  });
});

test("a cross-case Advisor and a non-reviewer are denied without disclosing or changing facts", async () => {
  const repository = setup();
  repository.seedCase({
    caseId: OTHER_CASE_ID,
    organizationId: ADVISOR.organizationId,
    primaryAdvisorUserId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  });
  const first = approvedOverlay({
    revisionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    revisionNumber: 1,
    value: "Eastern",
  });
  repository.seedOverlay({ revision: first });
  const current = resolveSchoolTargetView({ base: baseRecord(), revisions: [first] });
  const targetService = new SchoolTargetService({ repository, clock: new FixedClock(), createId: sequenceIds(500) });
  const resolutionService = new ResolvedSchoolViewService({
    repository,
    clock: new FixedClock(),
    createId: sequenceIds(600),
  });

  await assert.rejects(
    targetService.createSchoolTarget({
      actor: ADVISOR,
      caseId: OTHER_CASE_ID,
      schoolId: SCHOOL_ID,
      command: targetCommand(current.pin.resolutionSha256),
    }),
    targetError("SCHOOL_TARGET_CASE_NOT_FOUND"),
  );
  await assert.rejects(
    resolutionService.disableApprovedOverlay({
      actor: ADVISOR,
      schoolId: SCHOOL_ID,
      overlayRevisionId: first.revisionId,
      command: {
        expectedRecordVersion: 1,
        reason: "Not authorized",
        requestId: "request-p1-09-disable-002",
        idempotencyKey: "school-overlay-disable-p1-09-002",
      },
    }),
    resolutionError("SCHOOL_OVERLAY_REVIEWER_REQUIRED"),
  );
  assert.deepEqual(repository.snapshot(), {
    targets: 0,
    overlays: 1,
    resolvedRevisions: 0,
    audits: 0,
    outbox: 0,
    targetIdempotencyResults: 0,
    overlayIdempotencyResults: 0,
  });
});

test("target idempotency replays once and injected failure leaves no target or effect", async () => {
  const repository = setup();
  const first = approvedOverlay({
    revisionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    revisionNumber: 1,
    value: "Eastern",
  });
  repository.seedOverlay({ revision: first });
  const current = resolveSchoolTargetView({ base: baseRecord(), revisions: [first] });
  const service = new SchoolTargetService({ repository, clock: new FixedClock(), createId: sequenceIds(700) });
  const input = {
    actor: ADVISOR,
    caseId: CASE_ID,
    schoolId: SCHOOL_ID,
    command: targetCommand(current.pin.resolutionSha256),
  };

  const created = await service.createSchoolTarget(input);
  assert.deepEqual(await service.createSchoolTarget(input), created);
  await assert.rejects(
    service.createSchoolTarget({
      ...input,
      command: { ...input.command, expectedResolutionSha256: "f".repeat(64) },
    }),
    targetError("SCHOOL_TARGET_IDEMPOTENCY_KEY_REUSED"),
  );

  const failingRepository = setup();
  failingRepository.seedOverlay({ revision: first });
  failingRepository.failOnceBeforeCommit();
  const failingService = new SchoolTargetService({
    repository: failingRepository,
    clock: new FixedClock(),
    createId: sequenceIds(800),
  });
  await assert.rejects(
    failingService.createSchoolTarget({
      actor: ADVISOR,
      caseId: CASE_ID,
      schoolId: SCHOOL_ID,
      command: targetCommand(current.pin.resolutionSha256),
    }),
    /synthetic transaction failure/,
  );
  assert.deepEqual(failingRepository.snapshot(), {
    targets: 0,
    overlays: 1,
    resolvedRevisions: 0,
    audits: 0,
    outbox: 0,
    targetIdempotencyResults: 0,
    overlayIdempotencyResults: 0,
  });
});

function sequenceIds(start: number): () => string {
  let current = start;
  return () => {
    current += 1;
    return `00000000-0000-4000-8000-${String(current).padStart(12, "0")}`;
  };
}

function targetError(code: SchoolTargetError["code"]) {
  return (error: unknown) => {
    assert.ok(error instanceof SchoolTargetError);
    assert.equal(error.code, code);
    return true;
  };
}

function resolutionError(code: SchoolResolutionError["code"]) {
  return (error: unknown) => {
    assert.ok(error instanceof SchoolResolutionError);
    assert.equal(error.code, code);
    return true;
  };
}
