import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateSchoolOverlayApproval,
  sha256SchoolValue,
  type SchoolBaseRecord,
} from "../../modules/schools/contract.ts";
import { SchoolService, SchoolServiceError } from "../../modules/schools/service.ts";
import { InMemorySchoolRepository } from "../fakes/school-change.ts";

const ADVISOR = Object.freeze({
  userId: "11111111-1111-4111-8111-111111111111",
  organizationId: "22222222-2222-4222-8222-222222222222",
  role: "advisor" as const,
  sessionId: "33333333-3333-4333-8333-333333333333",
  capturedSessionVersion: 1,
  reauthenticatedAtMs: 1_754_265_600_000,
});
const SCHOOL_ID = "44444444-4444-4444-8444-444444444444";
const SNAPSHOT_ID = "55555555-5555-4555-8555-555555555555";

class FixedClock {
  nowMs(): number {
    return 1_754_265_600_000;
  }
}

function addBaseRecord(repository: InMemorySchoolRepository): SchoolBaseRecord {
  const base: SchoolBaseRecord = {
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
  repository.addBaseRecord(base);
  return base;
}

function changeCommand(overrides: Record<string, unknown> = {}) {
  return {
    fieldName: "district",
    fieldClass: "general" as const,
    baseSnapshotId: SNAPSHOT_ID,
    baseValueSha256: sha256SchoolValue("Central"),
    proposedValue: "Eastern",
    reason: "Official district listing was corrected.",
    evidence: {
      sourceUrl: "https://example.test/evidence/district",
      quote: "District: Eastern",
    },
    requestId: "request-p1-08-change-001",
    idempotencyKey: "school-change-p1-08-001",
    ...overrides,
  };
}

test("an Advisor creates a provisional School with required identity/reason and no guessed URL", async () => {
  const repository = new InMemorySchoolRepository();
  const service = new SchoolService({
    repository,
    clock: new FixedClock(),
    createId: sequenceIds(100),
  });

  const result = await service.createProvisionalSchool({
    actor: ADVISOR,
    command: {
      identity: "Synthetic Academy",
      district: "Central",
      system: "DSS",
      stage: "secondary",
      reason: "Family requested a school not present in the immutable snapshot.",
      requestId: "request-p1-08-provisional-001",
      idempotencyKey: "school-provisional-p1-08-001",
    },
  });

  assert.deepEqual(result, {
    schoolId: "00000000-0000-4000-8000-000000000101",
    status: "provisional",
    recordVersion: 1,
  });
  assert.deepEqual(repository.snapshot(), {
    provisionalSchools: 1,
    changeRequests: 0,
    candidateOverlays: 0,
    audits: 1,
    outbox: 1,
  });
  assert.deepEqual(repository.getProvisionalSchool(result.schoolId), {
    organizationId: ADVISOR.organizationId,
    identity: "Synthetic Academy",
    district: "Central",
    system: "DSS",
    stage: "secondary",
    reason: "Family requested a school not present in the immutable snapshot.",
    officialWebsite: null,
  });
  const effects = repository.getEffects(result.schoolId);
  assert.ok(effects);
  assert.doesNotMatch(JSON.stringify(effects), /Synthetic Academy|Family requested/i);
});

test("a submitted change remains a P0-08 candidate with requester separation and immutable base evidence", async () => {
  const repository = new InMemorySchoolRepository();
  addBaseRecord(repository);
  const service = new SchoolService({
    repository,
    clock: new FixedClock(),
    createId: sequenceIds(200),
  });

  const result = await service.submitSchoolChange({
    actor: ADVISOR,
    schoolId: SCHOOL_ID,
    command: changeCommand(),
  });

  assert.deepEqual(result, {
    changeRequestId: "00000000-0000-4000-8000-000000000201",
    schoolId: SCHOOL_ID,
    baseSnapshotId: SNAPSHOT_ID,
    fieldName: "district",
    status: "submitted",
    recordVersion: 1,
  });
  const candidate = repository.getCandidateOverlay(result.changeRequestId);
  assert.ok(candidate);
  assert.equal(candidate.status, "candidate");
  assert.equal(candidate.requestedBy, ADVISOR.userId);
  assert.equal(candidate.approvedBy, undefined);
  assert.deepEqual(candidate.changes, [
    {
      fieldName: "district",
      fieldClass: "general",
      proposedValue: "Eastern",
      baseValueSha256: sha256SchoolValue("Central"),
      evidence: {
        sourceUrl: "https://example.test/evidence/district",
        quote: "District: Eastern",
      },
    },
  ]);
  assert.equal(
    repository.baseValueHash({
      organizationId: ADVISOR.organizationId,
      schoolId: SCHOOL_ID,
      snapshotId: SNAPSHOT_ID,
      fieldName: "district",
    }),
    sha256SchoolValue("Central"),
  );
  assert.deepEqual(
    evaluateSchoolOverlayApproval({
      requestedBy: candidate.requestedBy,
      reviewerId: candidate.requestedBy,
      reviewerRole: "founder",
      fieldClasses: ["general"],
    }),
    { allowed: false, code: "SCHOOL_REVIEWER_SELF_REVIEW_DENIED" },
  );
  const effects = repository.getEffects(result.changeRequestId);
  assert.ok(effects);
  assert.doesNotMatch(JSON.stringify(effects), /Eastern|Official district|example\.test/i);
});

test("exact idempotency replay returns the first change request and altered reuse is denied", async () => {
  const repository = new InMemorySchoolRepository();
  addBaseRecord(repository);
  const service = new SchoolService({
    repository,
    clock: new FixedClock(),
    createId: sequenceIds(300),
  });
  const input = {
    actor: ADVISOR,
    schoolId: SCHOOL_ID,
    command: changeCommand({ requestId: "request-p1-08-change-002", idempotencyKey: "school-change-p1-08-002" }),
  };

  const first = await service.submitSchoolChange(input);
  assert.deepEqual(await service.submitSchoolChange(input), first);
  await assert.rejects(
    service.submitSchoolChange({
      ...input,
      command: { ...input.command, proposedValue: "Northern" },
    }),
    schoolError("SCHOOL_CHANGE_IDEMPOTENCY_KEY_REUSED"),
  );
  assert.deepEqual(repository.snapshot(), {
    provisionalSchools: 0,
    changeRequests: 1,
    candidateOverlays: 1,
    audits: 1,
    outbox: 1,
  });
});

test("missing provisional facts, invalid evidence, and a stale immutable base are rejected before any effect is committed", async () => {
  const repository = new InMemorySchoolRepository();
  addBaseRecord(repository);
  const service = new SchoolService({
    repository,
    clock: new FixedClock(),
    createId: sequenceIds(400),
  });

  await assert.rejects(
    service.createProvisionalSchool({
      actor: ADVISOR,
      command: {
        identity: " ",
        district: "Central",
        system: "DSS",
        stage: "secondary",
        reason: "Required for a valid command.",
        requestId: "request-p1-08-provisional-002",
        idempotencyKey: "school-provisional-p1-08-002",
      },
    }),
    schoolError("SCHOOL_COMMAND_INVALID"),
  );
  await assert.rejects(
    service.createProvisionalSchool({
      actor: ADVISOR,
      command: {
        identity: "Synthetic Academy",
        district: "Central",
        system: "DSS",
        stage: "secondary",
        reason: " ",
        requestId: "request-p1-08-provisional-003",
        idempotencyKey: "school-provisional-p1-08-003",
      },
    }),
    schoolError("SCHOOL_COMMAND_INVALID"),
  );
  await assert.rejects(
    service.submitSchoolChange({
      actor: ADVISOR,
      schoolId: SCHOOL_ID,
      command: changeCommand({
        evidence: { sourceUrl: "http://example.test/evidence", quote: "District: Eastern" },
      }),
    }),
    schoolError("SCHOOL_COMMAND_INVALID"),
  );
  await assert.rejects(
    service.submitSchoolChange({
      actor: ADVISOR,
      schoolId: SCHOOL_ID,
      command: changeCommand({
        baseValueSha256: sha256SchoolValue("Stale district"),
        requestId: "request-p1-08-change-003",
        idempotencyKey: "school-change-p1-08-003",
      }),
    }),
    schoolError("SCHOOL_CHANGE_BASE_STALE"),
  );
  assert.deepEqual(repository.snapshot(), {
    provisionalSchools: 0,
    changeRequests: 0,
    candidateOverlays: 0,
    audits: 0,
    outbox: 0,
  });
});

test("non-Advisor requests are denied without relying on a requester-controlled reviewer", async () => {
  const repository = new InMemorySchoolRepository();
  addBaseRecord(repository);
  const service = new SchoolService({
    repository,
    clock: new FixedClock(),
    createId: sequenceIds(500),
  });

  await assert.rejects(
    service.submitSchoolChange({
      actor: { ...ADVISOR, role: "founder" },
      schoolId: SCHOOL_ID,
      command: changeCommand(),
    }),
    schoolError("SCHOOL_ADVISOR_REQUIRED"),
  );
  assert.deepEqual(repository.snapshot(), {
    provisionalSchools: 0,
    changeRequests: 0,
    candidateOverlays: 0,
    audits: 0,
    outbox: 0,
  });
});

test("a repository failure leaves submitted change, candidate overlay, audit, and outbox absent", async () => {
  const repository = new InMemorySchoolRepository();
  addBaseRecord(repository);
  repository.failOnceBeforeCommit();
  const service = new SchoolService({
    repository,
    clock: new FixedClock(),
    createId: sequenceIds(600),
  });

  await assert.rejects(
    service.submitSchoolChange({ actor: ADVISOR, schoolId: SCHOOL_ID, command: changeCommand() }),
    /synthetic transaction failure/,
  );
  assert.deepEqual(repository.snapshot(), {
    provisionalSchools: 0,
    changeRequests: 0,
    candidateOverlays: 0,
    audits: 0,
    outbox: 0,
  });
});

function sequenceIds(start: number): () => string {
  let current = start;
  return () => {
    current += 1;
    return `00000000-0000-4000-8000-${String(current).padStart(12, "0")}`;
  };
}

function schoolError(code: SchoolServiceError["code"]) {
  return (error: unknown) => {
    assert.ok(error instanceof SchoolServiceError);
    assert.equal(error.code, code);
    return true;
  };
}
