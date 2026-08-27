import assert from "node:assert/strict";
import test from "node:test";

import { ApiClientError } from "../../../lib/api/client.ts";
import {
  CandidateListIdempotencyAttempt,
  createCandidateList,
  getGuardianConfirmationOptions,
  listCandidateLists,
  listCandidateSchoolOptions,
  recordGuardianCandidateListDecision,
  reviewCandidateList,
} from "../../../components/cases/candidate-list-client.ts";

const CASE_ID = id(1);
const VERSION_ID = id(2);
const SCHOOL_ID = id(3);
const REVISION_ID = id(4);
const GUARDIAN_ID = id(5);
const RELATIONSHIP_ID = id(6);
const USER_ID = id(7);
const ITEM_ID = id(8);
const HASH = "a".repeat(64);
const FOUNDER_HASH = "b".repeat(64);

test("CandidateList reads decode only exact frozen DTOs", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const requests: string[] = [];
  globalThis.fetch = async (input, init) => {
    requests.push(String(input));
    assert.equal(init?.method, "GET");
    if (String(input).includes("candidate-lists")) {
      return apiResponse({ items: [candidateVersion()], next_cursor: null });
    }
    if (String(input).includes("schools/options")) {
      return apiResponse({ items: [{
        school_id: SCHOOL_ID,
        display_name: "Synthetic School",
        resolved_revision_id: REVISION_ID,
        resolution_sha256: HASH,
      }], next_cursor: null });
    }
    return apiResponse({ items: [guardianOption()] });
  };

  const [lists, schools, guardians] = await Promise.all([
    listCandidateLists(CASE_ID),
    listCandidateSchoolOptions(),
    getGuardianConfirmationOptions(CASE_ID),
  ]);
  assert.deepEqual(requests, [
    `/api/v1/cases/${CASE_ID}/candidate-lists?limit=100`,
    "/api/v1/schools/options?limit=100",
    `/api/v1/cases/${CASE_ID}/guardian-confirmation-options`,
  ]);
  assert.equal(lists.items[0]?.status, "submitted");
  assert.equal(schools[0]?.resolved_revision_id, REVISION_ID);
  assert.equal(guardians[0]?.is_primary_contact, true);
  assert.equal(Object.isFrozen(lists), true);
  assert.equal(Object.isFrozen(lists.items), true);
});

test("CandidateList reads fail closed for extra fields and inconsistent decision state", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  for (const payload of [
    { items: [{ ...candidateVersion(), unexpected: true }], next_cursor: null },
    { items: [{ ...candidateVersion(), status: "confirmed" }], next_cursor: null },
  ]) {
    globalThis.fetch = async () => apiResponse(payload);
    await assert.rejects(
      listCandidateLists(CASE_ID),
      (error: unknown) => error instanceof ApiClientError && error.code === "MALFORMED_RESPONSE",
    );
  }
  globalThis.fetch = async () => apiResponse({ items: [{ ...guardianOption(), email: "hidden@test.invalid" }] });
  await assert.rejects(
    getGuardianConfirmationOptions(CASE_ID),
    (error: unknown) => error instanceof ApiClientError && error.code === "MALFORMED_RESPONSE",
  );
});

test("CandidateList commands send exact DTOs, versions and idempotency headers", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const calls: Readonly<{ input: string; init?: RequestInit }>[] = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ input: String(input), init });
    if (String(input).endsWith("/review")) {
      return apiResponse({ id: VERSION_ID, record_version: 3, founder_decision_sha256: FOUNDER_HASH });
    }
    if (String(input).endsWith("/guardian-decision")) {
      return apiResponse({
        id: VERSION_ID,
        record_version: 4,
        automation: {
          application_tasks: "pending",
          requested_count: 1,
          provisioned_count: 0,
        },
      });
    }
    return apiResponse({ id: VERSION_ID, record_version: 2 });
  };

  await createCandidateList(CASE_ID, {
    previous_version_id: null,
    expected_case_record_version: 4,
    change_summary: "Initial shortlist",
    items: [{ school_id: SCHOOL_ID, pinned_resolved_revision_id: REVISION_ID,
      pinned_resolution_sha256: HASH, ordinal: 1,
      application_deadline: "2026-10-01T09:00:00.000Z" }],
  }, "candidate-create-key");
  await reviewCandidateList(CASE_ID, VERSION_ID, {
    decision: "approved",
    expected_record_version: 2,
    reason: "Approved for Guardian confirmation",
  }, "candidate-review-key");
  const guardianReceipt = await recordGuardianCandidateListDecision(CASE_ID, VERSION_ID, {
    bound_founder_decision_sha256: FOUNDER_HASH,
    channel: "phone",
    decision: "confirmed",
    expected_case_record_version: 4,
    expected_list_record_version: 3,
    guardian_decided_at: "2026-08-27T02:00:00.000Z",
    guardian_id: GUARDIAN_ID,
    guardian_relationship_id: RELATIONSHIP_ID,
  }, "candidate-guardian-key");
  assert.deepEqual(guardianReceipt.automation, {
    application_tasks: "pending",
    requested_count: 1,
    provisioned_count: 0,
  });

  assert.equal(calls.length, 3);
  for (const [index, key] of ["candidate-create-key", "candidate-review-key", "candidate-guardian-key"].entries()) {
    assert.equal(calls[index]?.init?.method, "POST");
    assert.equal(new Headers(calls[index]?.init?.headers).get("idempotency-key"), key);
  }
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    previous_version_id: null,
    expected_case_record_version: 4,
    change_summary: "Initial shortlist",
    items: [{ school_id: SCHOOL_ID, pinned_resolved_revision_id: REVISION_ID,
      pinned_resolution_sha256: HASH, ordinal: 1,
      application_deadline: "2026-10-01T09:00:00.000Z" }],
  });
  assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), {
    decision: "approved",
    expected_record_version: 2,
    reason: "Approved for Guardian confirmation",
  });
  assert.deepEqual(JSON.parse(String(calls[2]?.init?.body)), {
    bound_founder_decision_sha256: FOUNDER_HASH,
    channel: "phone",
    decision: "confirmed",
    expected_case_record_version: 4,
    expected_list_record_version: 3,
    guardian_decided_at: "2026-08-27T02:00:00.000Z",
    guardian_id: GUARDIAN_ID,
    guardian_relationship_id: RELATIONSHIP_ID,
  });
});

test("one CandidateList attempt keeps its key until success and rotates for changed input", () => {
  const keys = ["attempt-one", "attempt-two"];
  const attempt = new CandidateListIdempotencyAttempt(() => keys.shift()!);
  assert.equal(attempt.keyFor("same command"), "attempt-one");
  assert.equal(attempt.keyFor("same command"), "attempt-one");
  assert.equal(attempt.keyFor("changed command"), "attempt-two");
});

test("CandidateList requires an explicit valid deadline but permits a past deadline", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount += 1;
    return apiResponse({ id: VERSION_ID, record_version: 2 });
  };
  const base = {
    previous_version_id: null,
    expected_case_record_version: 4,
    change_summary: "Deadline check",
  } as const;
  assert.throws(() => createCandidateList(CASE_ID, {
    ...base,
    items: [{ school_id: SCHOOL_ID, pinned_resolved_revision_id: REVISION_ID,
      pinned_resolution_sha256: HASH, ordinal: 1, application_deadline: "invalid" }],
  }, "deadline-invalid"), /application_deadline/);
  await createCandidateList(CASE_ID, {
    ...base,
    items: [{ school_id: SCHOOL_ID, pinned_resolved_revision_id: REVISION_ID,
      pinned_resolution_sha256: HASH, ordinal: 1,
      application_deadline: "2020-01-01T00:00:00.000Z" }],
  }, "deadline-past");
  assert.equal(requestCount, 1);
});

function candidateVersion() {
  return {
    id: VERSION_ID,
    version_number: 1,
    previous_version_id: null,
    school_set_sha256: HASH,
    status: "submitted",
    record_version: 2,
    change_summary: "Initial shortlist",
    created_by_user_id: USER_ID,
    created_at: "2026-08-27T01:00:00.000Z",
    submitted_at: "2026-08-27T01:00:00.000Z",
    items: [{
      id: ITEM_ID,
      school_id: SCHOOL_ID,
      pinned_resolved_revision_id: REVISION_ID,
      pinned_resolution_sha256: HASH,
      ordinal: 1,
      application_deadline: null,
      school_target_id: null,
    }],
    founder_approval: null,
    guardian_decision: null,
  };
}

function guardianOption() {
  return {
    guardian_id: GUARDIAN_ID,
    guardian_relationship_id: RELATIONSHIP_ID,
    display_name: "Synthetic Guardian",
    relationship_type: "mother",
    relationship_description: null,
    is_legal_guardian: true,
    is_primary_contact: true,
  };
}

function apiResponse(data: unknown): Response {
  return Response.json(
    { api_version: "v1", request_id: "candidate-client-test", data },
    { headers: { "x-request-id": "candidate-client-test" } },
  );
}

function id(last: number): string {
  return `87000000-0000-4000-8000-${String(last).padStart(12, "0")}`;
}
