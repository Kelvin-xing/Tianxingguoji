import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { ApiClientError } from "../../../lib/api/client.ts";
import {
  classifySchoolTargetFailure,
  getSchoolTargets,
} from "../../../modules/cases/client.ts";

const CASE_ID = "10000000-0000-4000-8000-000000000001";
const SCHOOL_ID = "20000000-0000-4000-8000-000000000001";
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
  assert.equal(result.can_create, false);
  assert.equal(result.create_blocked_reason, "selection_workflow_required");
  assert.equal(result.items.length, 0);
  assert.deepEqual(result.school_options, []);
});

test("strict decoder rejects any SchoolTarget create advertisement or identity drift", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });

  const malformedViews = [
    { ...viewFixture(), unexpected: true },
    { ...viewFixture(), case_id: "10000000-0000-4000-8000-000000000099" },
    { ...viewFixture(), can_create: true },
    { ...viewFixture(), create_blocked_reason: null },
    { ...viewFixture(), create_blocked_reason: "case_stage_not_allowed" },
    { ...viewFixture(), school_options: [optionFixture(SCHOOL_ID)] },
    {
      ...viewFixture(),
      items: [{ ...itemFixture(), intake_year: 2028 }],
    },
  ] as const;

  for (const malformed of malformedViews) {
    globalThis.fetch = async () => apiResponse(malformed);
    await assert.rejects(
      getSchoolTargets(CASE_ID),
      (error: unknown) => error instanceof ApiClientError && error.code === "MALFORMED_RESPONSE",
    );
  }

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

test("SchoolTargetsPanel is a read-only Case detail projection without legacy writes", () => {
  const panelSource = readFileSync(
    new URL("../../../components/cases/SchoolTargetsPanel.tsx", import.meta.url),
    "utf8",
  );
  const clientSource = readFileSync(
    new URL("../../../modules/cases/client.ts", import.meta.url),
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
    "此處只顯示現有目標；新增與流程變更由已核准的選校流程處理。",
    "尚未建立學校目標",
  ]) {
    assert.equal(panelSource.includes(businessCopy), true, businessCopy);
  }
  assert.match(panelSource, /getSchoolTargets/);
  assert.doesNotMatch(panelSource, /createSchoolTarget|transitionSchoolTarget|recordSchoolTargetOutcome/);
  assert.doesNotMatch(panelSource, /<form|>建立學校目標<|>推進狀態<|>記錄結果</);
  assert.match(clientSource, /SCHOOL_TARGET_CREATE_BLOCKED_REASON = "selection_workflow_required"/);
  assert.match(clientSource, /readonly can_create: false/);
  assert.match(clientSource, /readonly school_options: readonly \[\]/);
  assert.doesNotMatch(clientSource, /export (?:async function createSchoolTarget|class SchoolTargetIdempotencyAttempt)/);
});

function viewFixture() {
  return {
    case_id: CASE_ID,
    case_stage: "background_collection",
    intake_year: 2027,
    admission_type: "hk_k12_standard_v1",
    can_create: false,
    create_blocked_reason: "selection_workflow_required",
    items: [],
    school_options: [],
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
