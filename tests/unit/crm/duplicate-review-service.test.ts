import assert from "node:assert/strict";
import test from "node:test";

import {
  DuplicateReviewError,
  DuplicateReviewService,
  type DuplicateReviewRepository,
} from "../../../modules/crm/application/duplicate-review-service.ts";
import type { IdentitySessionActor } from "../../../modules/identity/public.ts";

const IDS = Object.freeze({
  organization: "51000000-0000-4000-8000-000000000001",
  actor: "51000000-0000-4000-8000-000000000101",
  left: "51000000-0000-4000-8000-000000000601",
  right: "51000000-0000-4000-8000-000000000602",
  candidate: "71000000-0000-4000-8000-000000000001",
  audit: "71000000-0000-4000-8000-000000000002",
  outbox: "71000000-0000-4000-8000-000000000003",
});

test("allows review for Founder, Advisor and Data Reviewer while merge stays Founder-only", async () => {
  const calls: string[] = [];
  const repository = fakeRepository(calls);
  for (const role of ["founder", "advisor", "data_reviewer"] as const) {
    await new DuplicateReviewService(repository).searchRecords(actor(role), "student", "Synthetic");
  }
  assert.deepEqual(calls, ["search", "search", "search"]);

  for (const role of ["admin", "contractor"] as const) {
    await forbidden(() => new DuplicateReviewService(repository).searchRecords(actor(role), "student", "xx"));
  }
  for (const role of ["advisor", "admin", "data_reviewer", "contractor"] as const) {
    await forbidden(() => new DuplicateReviewService(repository).mergeCandidate({ actor: actor(role), command: {
      candidateId: IDS.candidate, sourceRecordId: IDS.left, canonicalRecordId: IDS.right,
      expectedCandidateRecordVersion: 1, expectedSourceRecordVersion: 1,
      expectedCanonicalRecordVersion: 1, fieldSelections: studentSelections(),
      reasonCode: "duplicate.confirmed", requestId: `merge-${role}`, idempotencyKey: `merge-${role}`,
    } }));
  }
  assert.deepEqual(calls, ["search", "search", "search"]);
});

test("candidate creation hashes only the canonical request and produces PII-free effects", async () => {
  let captured: Parameters<DuplicateReviewRepository["createCandidate"]>[0] | undefined;
  const repository = fakeRepository([], { createCandidate(input) { captured = input; return Promise.resolve({
    candidateId: input.candidateId, entityType: input.entityType, leftRecordId: input.leftRecordId,
    rightRecordId: input.rightRecordId, leftDisplayLabel: "Safe Left", rightDisplayLabel: "Safe Right",
    matchingSignals: ["display_name"], status: "review_required", mergeId: null, recordVersion: 1,
  }); } });
  const ids = [IDS.candidate, IDS.audit, IDS.outbox];
  await new DuplicateReviewService(repository, () => ids.shift()!, () => 1_777_075_200_000)
    .createCandidate({ actor: actor("advisor"), command: { entityType: "student",
      leftRecordId: IDS.left, rightRecordId: IDS.right, requestId: "candidate-create",
      idempotencyKey: "candidate-create-1" } });
  assert.match(captured?.requestHash ?? "", /^[0-9a-f]{64}$/);
  const effects = JSON.stringify(captured?.effects);
  for (const forbiddenValue of ["Synthetic Person", "person@example.invalid", "+85220000000"]) {
    assert.equal(effects.includes(forbiddenValue), false);
  }
  assert.deepEqual(captured?.effects.audit.metadata, {
    effect_type: "duplicate_candidate_created",
  });
});

test("rejects invalid list enums before persistence", async () => {
  const calls: string[] = [];
  const service = new DuplicateReviewService(fakeRepository(calls));
  await assert.rejects(
    async () => service.listCandidates(actor("founder"), "student", "dismissed" as never),
    isError("DUPLICATE_REVIEW_INVALID"),
  );
  assert.deepEqual(calls, []);
});

test("returns the repository candidate comparison pair without canonicalizing either profile", async () => {
  const expected = Object.freeze({
    candidate: Object.freeze({ candidateId: IDS.candidate, entityType: "student" as const,
      leftRecordId: IDS.left, rightRecordId: IDS.right, leftDisplayLabel: "Left",
      rightDisplayLabel: "Right", matchingSignals: Object.freeze(["email" as const]),
      status: "merged" as const, mergeId: "71000000-0000-4000-8000-000000000004", recordVersion: 2 }),
    leftProfile: Object.freeze({ id: IDS.left, entityType: "student" as const, displayName: "Left current",
      dateOfBirth: null, contactEmail: "left@example.invalid", contactPhone: null, recordVersion: 3 }),
    rightProfile: Object.freeze({ id: IDS.right, entityType: "student" as const, displayName: "Right current",
      dateOfBirth: null, contactEmail: "right@example.invalid", contactPhone: null, recordVersion: 4 }),
    supportedFields: Object.freeze(["display_name", "date_of_birth", "contact_email", "contact_phone"]),
    merge: Object.freeze({ id: "71000000-0000-4000-8000-000000000004", sourceRecordId: IDS.left,
      canonicalRecordId: IDS.right, provenanceRevisionId: "71000000-0000-4000-8000-000000000005",
      status: "active" as const, recordVersion: 1, correctionId: null }),
  });
  const service = new DuplicateReviewService(fakeRepository([], {
    async findCandidate() { return expected; },
  }));
  const actual = await service.findCandidate(actor("founder"), IDS.candidate);
  assert.strictEqual(actual, expected);
  assert.equal(actual?.leftProfile.id, actual?.candidate.leftRecordId);
  assert.equal(actual?.rightProfile.id, actual?.candidate.rightRecordId);
});

function actor(role: IdentitySessionActor["role"]): IdentitySessionActor {
  return Object.freeze({ userId: IDS.actor, organizationId: IDS.organization, role,
    sessionId: "51000000-0000-4000-8000-000000000901", capturedSessionVersion: 1,
    reauthenticatedAtMs: null });
}
function studentSelections() { return ["display_name", "date_of_birth", "contact_email", "contact_phone"]
  .map((fieldName) => ({ fieldName, sourceRecordId: IDS.left })); }
function fakeRepository(calls: string[], overrides: Partial<DuplicateReviewRepository> = {}): DuplicateReviewRepository {
  return {
    async searchRecords() { calls.push("search"); return []; },
    async listCandidates() { calls.push("list"); return []; },
    async findCandidate() { calls.push("find"); return null; },
    async createCandidate() { throw new Error("unexpected create"); },
    async mergeCandidate() { calls.push("merge"); throw new Error("unexpected merge"); },
    async correctMerge() { calls.push("correct"); throw new Error("unexpected correct"); },
    ...overrides,
  };
}
function isError(code: DuplicateReviewError["code"]) {
  return (error: unknown) => error instanceof DuplicateReviewError && error.code === code;
}
async function forbidden(action: () => Promise<unknown>) {
  await assert.rejects(async () => action(), isError("DUPLICATE_REVIEW_FORBIDDEN"));
}
