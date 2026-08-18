import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { ApiClientError } from "../../../lib/api/client.ts";
import {
  SchoolTargetIdempotencyAttempt,
  classifySchoolTargetFailure,
  createSchoolTarget,
  getSchoolTargets,
  hasSchoolTarget,
} from "../../../modules/cases/client.ts";

const CASE_ID = "10000000-0000-4000-8000-000000000001";
const SCHOOL_ID = "20000000-0000-4000-8000-000000000001";
const OTHER_SCHOOL_ID = "20000000-0000-4000-8000-000000000002";
const TARGET_ID = "30000000-0000-4000-8000-000000000001";
const REVISION_ID = "40000000-0000-4000-8000-000000000001";
const HASH = "a".repeat(64);

test("GET decodes the frozen SchoolTarget view and uses a cancellable same-origin request", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const controller = new AbortController();

  globalThis.fetch = async (input, init) => {
    assert.equal(input, `/api/v1/cases/${CASE_ID}/school-targets`);
    assert.equal(init?.method, "GET");
    assert.equal(init?.signal instanceof AbortSignal, true);
    assert.equal(new Headers(init?.headers).get("accept"), "application/json");
    return apiResponse(viewFixture());
  };

  const result = await getSchoolTargets(CASE_ID, controller.signal);
  assert.equal(result.case_id, CASE_ID);
  assert.equal(result.can_create, true);
  assert.equal(result.items.length, 0);
  assert.deepEqual(result.school_options.map(({ school_id }) => school_id), [SCHOOL_ID]);
});

test("POST sends only school identity and expected resolved hash", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });

  globalThis.fetch = async (input, init) => {
    assert.equal(input, `/api/v1/cases/${CASE_ID}/school-targets`);
    assert.equal(init?.method, "POST");
    assert.equal(new Headers(init?.headers).get("idempotency-key"), "school-target-attempt-1");
    assert.deepEqual(JSON.parse(String(init?.body)), {
      school_id: SCHOOL_ID,
      expected_resolution_sha256: HASH,
    });
    assert.equal(String(init?.body).includes("intake_year"), false);
    assert.equal(String(init?.body).includes("admission_type"), false);
    return apiResponse({ case_id: CASE_ID, item: itemFixture() });
  };

  const result = await createSchoolTarget(
    CASE_ID,
    { school_id: SCHOOL_ID, expected_resolution_sha256: HASH },
    "school-target-attempt-1",
  );
  assert.equal(result.item.target_id, TARGET_ID);
  assert.equal(result.item.state, "candidate");
});

test("strict decoders reject malformed, excessive, overlapping, and mismatched data", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });

  const malformedViews = [
    { ...viewFixture(), unexpected: true },
    {
      ...viewFixture(),
      school_options: [1, 2, 3, 4].map((index) => optionFixture(
        `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      )),
    },
    {
      ...viewFixture(),
      items: [itemFixture()],
      school_options: [optionFixture(SCHOOL_ID)],
    },
    { ...viewFixture(), case_id: "10000000-0000-4000-8000-000000000099" },
    { ...viewFixture(), can_create: false, create_blocked_reason: null },
  ] as const;

  for (const malformed of malformedViews) {
    globalThis.fetch = async () => apiResponse(malformed);
    await assert.rejects(
      getSchoolTargets(CASE_ID),
      (error: unknown) => error instanceof ApiClientError && error.code === "MALFORMED_RESPONSE",
    );
  }

  globalThis.fetch = async () => apiResponse({
    case_id: CASE_ID,
    item: { ...itemFixture(), resolution_sha256: HASH.toUpperCase() },
  });
  await assert.rejects(
    createSchoolTarget(
      CASE_ID,
      { school_id: SCHOOL_ID, expected_resolution_sha256: HASH },
      "school-target-attempt-2",
    ),
    (error: unknown) => error instanceof ApiClientError && error.code === "MALFORMED_RESPONSE",
  );
});

test("idempotency attempt preserves uncertain retries and rotates for selection or stale changes", () => {
  let sequence = 0;
  const attempt = new SchoolTargetIdempotencyAttempt(() => `attempt-${++sequence}`);

  const first = attempt.keyFor(SCHOOL_ID);
  assert.equal(attempt.keyFor(SCHOOL_ID), first, "network and 503 retries reuse the same key");

  attempt.rotate();
  const afterStale = attempt.keyFor(SCHOOL_ID);
  assert.notEqual(afterStale, first);

  const afterSelectionChange = attempt.keyFor(OTHER_SCHOOL_ID);
  assert.notEqual(afterSelectionChange, afterStale);

  attempt.complete();
  assert.notEqual(attempt.keyFor(OTHER_SCHOOL_ID), afterSelectionChange);
});

test("failure classification covers unauthenticated, forbidden, stale, conflict, and unavailable states", () => {
  assert.equal(classifySchoolTargetFailure(apiError("UNAUTHENTICATED", 401)), "unauthenticated");
  assert.equal(classifySchoolTargetFailure(apiError("FORBIDDEN", 403)), "forbidden");
  assert.equal(classifySchoolTargetFailure(apiError("NOT_FOUND", 404)), "forbidden");
  assert.equal(classifySchoolTargetFailure(apiError("STALE_VERSION", 409)), "stale");
  assert.equal(classifySchoolTargetFailure(apiError("CONFLICT", 409)), "conflict");
  assert.equal(classifySchoolTargetFailure(apiError("SERVICE_UNAVAILABLE", 503, true)), "unavailable");
  assert.equal(classifySchoolTargetFailure(new Error("private detail")), "unavailable");
});

test("duplicate state is derived only after an authoritative refreshed item exists", () => {
  assert.equal(hasSchoolTarget(viewFixture(), SCHOOL_ID), false);
  assert.equal(hasSchoolTarget({
    ...viewFixture(),
    can_create: false,
    create_blocked_reason: "no_school_options",
    items: [itemFixture()],
    school_options: [],
  }, SCHOOL_ID), true);
});

test("SchoolTargetsPanel does not expose implementation terms in user-facing copy", () => {
  const panelSource = readFileSync(
    new URL("../../../components/cases/SchoolTargetsPanel.tsx", import.meta.url),
    "utf8",
  );

  for (const forbiddenTerm of [
    "PostgreSQL",
    "ServiceCase",
    "synthetic",
    "請求憑據",
    "Request ID:",
  ]) {
    assert.equal(panelSource.includes(forbiddenTerm), false, forbiddenTerm);
  }

  for (const businessCopy of [
    "正在讀取本案的學校目標。",
    "入學年度和申請類型沿用本案設定。",
    "選擇學校",
    "目前沒有可新增的學校。",
    "請稍後重試；重試不會重複建立目標。",
  ]) {
    assert.equal(panelSource.includes(businessCopy), true, businessCopy);
  }
});

function viewFixture() {
  return {
    case_id: CASE_ID,
    case_stage: "background_collection",
    intake_year: 2027,
    admission_type: "hk_k12_standard_v1",
    can_create: true,
    create_blocked_reason: null,
    items: [],
    school_options: [optionFixture(SCHOOL_ID)],
  } as const;
}

function itemFixture() {
  return {
    target_id: TARGET_ID,
    school_id: SCHOOL_ID,
    school_name: "Synthetic School One",
    state: "candidate",
    intake_year: 2027,
    admission_type: "hk_k12_standard_v1",
    record_version: 1,
    resolved_revision_id: REVISION_ID,
    resolution_sha256: HASH,
    created_at: "2026-08-18T00:00:00.000Z",
  } as const;
}

function optionFixture(schoolId: string) {
  return {
    school_id: schoolId,
    display_name: `Synthetic School ${schoolId.slice(-1)}`,
    resolution_sha256: HASH,
  } as const;
}

function apiResponse(data: unknown): Response {
  return Response.json({ api_version: "v1", request_id: "school-target-test", data }, {
    headers: { "x-request-id": "school-target-test" },
  });
}

function apiError(code: string, status: number, retryable = false): ApiClientError {
  return new ApiClientError({ code, status, retryable, requestId: "school-target-test" });
}
