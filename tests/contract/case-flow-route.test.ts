import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertWorkflowCaseId,
  mapCaseWorkflowError,
  parseCaseWorkflowActionRequest,
} from "../../app/api/v1/cases/[caseId]/workflow-actions/route-support.ts";
import { CaseWorkflowError } from "../../modules/cases/application/workflow-service.ts";
import { ApiContractError } from "../../modules/shared/public.ts";

const CASE_ID = "71000000-0000-4000-8000-000000000001";

test("workflow action request accepts only exact pause/resume DTOs", async () => {
  const pause = await parseCaseWorkflowActionRequest(request({
    action: "pause",
    expected_record_version: 2,
    reason: "Awaiting family decision",
  }), "case-flow-request");
  assert.deepEqual(pause, {
    action: "pause",
    expectedRecordVersion: 2,
    reason: "Awaiting family decision",
    requestId: "case-flow-request",
    idempotencyKey: "case-flow-key",
  });
  const resume = await parseCaseWorkflowActionRequest(request({
    action: "resume",
    expected_record_version: 3,
    reason: null,
  }), "case-flow-request");
  assert.equal(resume.reason, null);

  for (const body of [
    { action: "pause", expected_record_version: 2 },
    { action: "pause", expected_record_version: 2, reason: "ok", extra: true },
  ]) {
    await assert.rejects(
      parseCaseWorkflowActionRequest(request(body), "case-flow-request"),
      apiError("INVALID_REQUEST"),
    );
  }
  await assert.rejects(
    parseCaseWorkflowActionRequest(request({
      action: "terminate",
      expected_record_version: 2,
      reason: "x",
    }), "case-flow-request"),
    apiError("VALIDATION_FAILED"),
  );
  assert.doesNotThrow(() => assertWorkflowCaseId(CASE_ID));
  assert.throws(() => assertWorkflowCaseId("not-a-uuid"), apiError("INVALID_REQUEST"));
});

test("workflow action errors expose only stable status and numeric stale authority", () => {
  const stale = mapCaseWorkflowError(new CaseWorkflowError("CASE_WORKFLOW_STALE_VERSION", {
    currentRecordVersion: 4,
  }));
  assert.ok(stale instanceof ApiContractError);
  assert.equal(stale.code, "STALE_VERSION");
  assert.deepEqual(stale.details, { current_version: 4 });
  assert.equal(JSON.stringify(stale).includes(CASE_ID), false);

  for (const [source, expected] of [
    [new CaseWorkflowError("CASE_WORKFLOW_FORBIDDEN"), "FORBIDDEN"],
    [new CaseWorkflowError("CASE_WORKFLOW_CASE_NOT_FOUND"), "NOT_FOUND"],
    [new CaseWorkflowError("CASE_WORKFLOW_CONFLICT"), "CONFLICT"],
  ] as const) {
    const mapped = mapCaseWorkflowError(source);
    assert.ok(mapped instanceof ApiContractError);
    assert.equal(mapped.code, expected);
  }
});

test("retired Case write routes authorize and validate path without parsing body or reaching runtime", async () => {
  const paths = [
    "app/api/v1/cases/[caseId]/transitions/route.ts",
    "app/api/v1/cases/[caseId]/school-targets/route.ts",
    "app/api/v1/cases/[caseId]/school-targets/[targetId]/transitions/route.ts",
    "app/api/v1/cases/[caseId]/school-targets/[targetId]/outcomes/route.ts",
  ];
  for (const path of paths) {
    const source = await readFile(path, "utf8");
    const post = source.slice(source.indexOf("export async function POST"));
    assert.match(post, /requireIdentityActor/);
    assert.match(post, /cases\.workflow\.manage/);
    assert.match(post, /VALIDATION_FAILED/);
    assert.match(post, /CONFLICT/);
    assert.doesNotMatch(post, /request\.json|getCase\w*Runtime/);
  }
});

test("retired non-versioned Case surfaces are fixed conflicts after capability checks", async () => {
  for (const path of ["app/api/cases/route.ts", "app/api/cases/options/route.ts"]) {
    const source = await readFile(path, "utf8");
    assert.match(source, /requireIdentityActor/);
    assert.match(source, /evaluateBootstrapAuthorization/);
    assert.match(source, /createApiError\("CONFLICT"\)/);
    assert.doesNotMatch(source, /request\.json|getCaseRuntime|getCaseWorkspaceRuntime/);
  }
});

function request(body: unknown): Request {
  return new Request(`http://localhost/api/v1/cases/${CASE_ID}/workflow-actions`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "case-flow-key" },
    body: JSON.stringify(body),
  });
}

function apiError(code: ApiContractError["code"]): (error: unknown) => boolean {
  return (error) => error instanceof ApiContractError && error.code === code;
}
