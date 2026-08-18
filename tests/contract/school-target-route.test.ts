import assert from "node:assert/strict";
import test from "node:test";

import { parseCreateSchoolTargetRequest } from "../../app/api/v1/cases/[caseId]/school-targets/route-contract.ts";
import { ApiContractError } from "../../modules/shared/public.ts";

const SCHOOL_ID = "40000000-0000-4000-8000-000000000101";
const HASH = "a".repeat(64);

test("accepts only the frozen SchoolTarget POST body", async () => {
  const parsed = await parseCreateSchoolTargetRequest(request({
    school_id: SCHOOL_ID,
    expected_resolution_sha256: HASH,
  }), "request-phase2d");

  assert.deepEqual(parsed, {
    schoolId: SCHOOL_ID,
    command: {
      expectedResolutionSha256: HASH,
      requestId: "request-phase2d",
      idempotencyKey: "phase2d-target-create",
    },
  });
});

test("rejects browser-owned case fields and every unknown field with 400", async () => {
  for (const extra of [
    { intake_year: 2035 },
    { admission_type: "forged" },
    { other: true },
  ]) {
    await assert.rejects(
      parseCreateSchoolTargetRequest(request({
        school_id: SCHOOL_ID,
        expected_resolution_sha256: HASH,
        ...extra,
      }), "request-phase2d"),
      apiError("INVALID_REQUEST"),
    );
  }
});

test("requires both fields and a valid Idempotency-Key", async () => {
  await assert.rejects(
    parseCreateSchoolTargetRequest(request({ school_id: SCHOOL_ID }), "request-phase2d"),
    apiError("INVALID_REQUEST"),
  );
  await assert.rejects(
    parseCreateSchoolTargetRequest(request({
      school_id: SCHOOL_ID,
      expected_resolution_sha256: HASH,
    }, "invalid key with spaces"), "request-phase2d"),
    apiError("INVALID_REQUEST"),
  );
});

function request(body: unknown, idempotencyKey = "phase2d-target-create"): Request {
  return new Request("http://localhost/api/v1/cases/example/school-targets", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(body),
  });
}

function apiError(code: ApiContractError["code"]) {
  return (error: unknown) => {
    assert.ok(error instanceof ApiContractError);
    assert.equal(error.code, code);
    return true;
  };
}
