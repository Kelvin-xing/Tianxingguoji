import assert from "node:assert/strict";
import test from "node:test";

import {
  caseIntakeOptionsData,
  caseIntakeReceiptData,
  mapCaseIntakeError,
  parseCaseIntakeOptions,
  parseCaseIntakeRequest,
} from "../../app/api/v1/cases/intake-route-contract.ts";
import { CaseIntakeError } from "../../modules/cases/application/intake-service.ts";
import { ApiContractError } from "../../modules/shared/public.ts";

const BODY = Object.freeze({
  student_id: "83000000-0000-4000-8000-000000000001",
  primary_advisor_role_binding_id: "83000000-0000-4000-8000-000000000002",
  referral_source_id: null,
  intake_year: 2027,
  admission_type: "entry",
  signed_at: "2026-08-26T10:30:00+08:00",
});

test("Case intake parser accepts exact body and rejects client manifest or extra fields", async () => {
  const parsed = await parseCaseIntakeRequest(request(BODY), "d5-request");
  assert.deepEqual(parsed, {
    studentId: BODY.student_id,
    primaryAdvisorRoleBindingId: BODY.primary_advisor_role_binding_id,
    referralSourceId: BODY.referral_source_id,
    intakeYear: BODY.intake_year,
    admissionType: BODY.admission_type,
    signedAt: BODY.signed_at,
    requestId: "d5-request",
    idempotencyKey: "d5-key",
  });
  await assert.rejects(parseCaseIntakeRequest(request({ ...BODY, manifest_id: "x" }), "d5"), apiError("INVALID_REQUEST"));
  await assert.rejects(parseCaseIntakeRequest(request({ ...BODY, actor: "x" }), "d5"), apiError("INVALID_REQUEST"));
  await assert.rejects(parseCaseIntakeRequest(request(BODY, { "content-type": "text/plain" }), "d5"), apiError("INVALID_REQUEST"));
  await assert.rejects(parseCaseIntakeRequest(request(BODY, { "idempotency-key": "" }), "d5"), apiError("INVALID_REQUEST"));
});

test("options parser only accepts three query filters and receipt has exact keys", () => {
  const filters = parseCaseIntakeOptions(new Request("http://localhost/api/v1/cases/intake-options?student_q=An%20&advisor_q=Lee&source_q=web"));
  assert.deepEqual(filters, { studentQuery: "An", advisorQuery: "Lee", referralSourceQuery: "web" });
  assert.throws(() => parseCaseIntakeOptions(new Request("http://localhost/api/v1/cases/intake-options?total=1")), apiError("INVALID_REQUEST"));
  assert.deepEqual(Object.keys(caseIntakeReceiptData({
    caseId: BODY.student_id,
    stage: "background_collection",
    workflowStatus: "active",
    recordVersion: 2,
    assessmentManifest: { id: BODY.primary_advisor_role_binding_id, version: "k12-v1" },
    assessmentUrl: "/cases/x/assessment",
  })).sort(), ["assessment_manifest", "assessment_url", "case_id", "record_version", "stage", "workflow_status"]);
  assert.deepEqual(Object.keys(caseIntakeOptionsData({ students: [], advisors: [], referralSources: [] })).sort(), ["advisors", "referral_sources", "students"]);
});

test("field errors survive shared envelope sanitizer but private fields do not", () => {
  const mapped = mapCaseIntakeError(new CaseIntakeError("CASE_INTAKE_INVALID", {
    student_id: "invalid_uuid",
    signed_at: "invalid_iso8601",
  }));
  assert.ok(mapped instanceof ApiContractError);
  assert.deepEqual(mapped.details, { field_errors: { student_id: "invalid_uuid", signed_at: "invalid_iso8601" } });
  const privateMapped = new ApiContractError("VALIDATION_FAILED", {
    field_errors: { request_id: "secret", student_id: "invalid_uuid" },
  });
  assert.deepEqual(privateMapped.details, {});
});

function request(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/v1/cases", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "d5-key", ...headers },
    body: JSON.stringify(body),
  });
}

function apiError(code: ApiContractError["code"]): (error: unknown) => boolean {
  return (error) => error instanceof ApiContractError && error.code === code;
}
