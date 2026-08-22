import assert from "node:assert/strict";
import test from "node:test";

import {
  mapCaseWorkspaceCollectionError,
  mapCaseWorkspaceDetailError,
  parseCaseCreateRequest,
} from "../../app/api/v1/cases/route-contract.ts";
import {
  CaseWorkspaceError,
  isCaseWorkspaceError,
} from "../../modules/cases/application/workspace-service.ts";
import { ApiContractError } from "../../modules/shared/public.ts";

const VALID_BODY = Object.freeze({
  student_id: "51000000-0000-4000-8000-000000000601",
  intake_year: 2027,
  admission_type: "transfer",
  primary_role_binding_id: "51000000-0000-4000-8000-000000000201",
  manifest_id: "51000000-0000-4000-8000-000000000801",
});

test("case create request freezes the exact DTO and idempotency contract", async () => {
  const command = await parseCaseCreateRequest(request(VALID_BODY), "case-request-1");
  assert.deepEqual(command, {
    studentId: VALID_BODY.student_id,
    intakeYear: 2027,
    admissionType: "transfer",
    primaryRoleBindingId: VALID_BODY.primary_role_binding_id,
    manifestId: VALID_BODY.manifest_id,
    requestId: "case-request-1",
    idempotencyKey: "case-key-1",
  });

  await assert.rejects(
    parseCaseCreateRequest(request({ ...VALID_BODY, organization_id: "injected" }), "case-request-2"),
    apiError("INVALID_REQUEST"),
  );
  await assert.rejects(
    parseCaseCreateRequest(request({ ...VALID_BODY, intake_year: "2027" }), "case-request-3"),
    apiError("VALIDATION_FAILED"),
  );
  await assert.rejects(
    parseCaseCreateRequest(request(VALID_BODY, { "content-type": "text/plain" }), "case-request-4"),
    apiError("INVALID_REQUEST"),
  );
  await assert.rejects(
    parseCaseCreateRequest(request(VALID_BODY, { "idempotency-key": "" }), "case-request-5"),
    apiError("INVALID_REQUEST"),
  );
});

test("case workspace error guard survives constructor duplication and rejects unknown codes", () => {
  const duplicated = Object.assign(new Error("duplicated module instance"), {
    name: "CaseWorkspaceError",
    code: "CASE_WORKSPACE_FORBIDDEN",
  });
  assert.equal(isCaseWorkspaceError(duplicated), true);
  assert.equal(isCaseWorkspaceError(duplicated, "CASE_WORKSPACE_FORBIDDEN"), true);
  assert.equal(isCaseWorkspaceError(Object.assign(new Error(), {
    name: "CaseWorkspaceError",
    code: "CASE_WORKSPACE_UNKNOWN",
  })), false);
  assert.equal(isCaseWorkspaceError({ name: "CaseWorkspaceError", code: "CASE_WORKSPACE_FORBIDDEN" }), false);
});

test("case workspace route mapping is allowlisted and fail closed", () => {
  assertMapped("CASE_WORKSPACE_FORBIDDEN", "FORBIDDEN", false);
  assertMapped("CASE_WORKSPACE_STUDENT_NOT_FOUND", "NOT_FOUND", false);
  assertMapped("CASE_WORKSPACE_DUPLICATE", "CONFLICT", false);
  assertMapped("CASE_WORKSPACE_IDEMPOTENCY_CONFLICT", "CONFLICT", false);
  assertMapped("CASE_WORKSPACE_IDEMPOTENCY_IN_PROGRESS", "CONFLICT", false);
  assertMapped("CASE_WORKSPACE_BINDING_INACTIVE", "VALIDATION_FAILED", false);
  assertMapped("CASE_WORKSPACE_MANIFEST_NOT_APPROVED", "VALIDATION_FAILED", false);
  assertMapped("CASE_WORKSPACE_INVALID", "VALIDATION_FAILED", false);
  assertMapped("CASE_WORKSPACE_INVALID", "NOT_FOUND", true);

  const unknown = Object.assign(new Error("private"), {
    name: "CaseWorkspaceError",
    code: "CASE_WORKSPACE_UNKNOWN",
  });
  assert.equal(mapCaseWorkspaceCollectionError(unknown), unknown);
});

function assertMapped(
  caseCode: ConstructorParameters<typeof CaseWorkspaceError>[0],
  apiCode: ApiContractError["code"],
  detail: boolean,
): void {
  const source = Object.assign(new Error("duplicated module instance"), {
    name: "CaseWorkspaceError",
    code: caseCode,
  });
  const mapped = detail
    ? mapCaseWorkspaceDetailError(source)
    : mapCaseWorkspaceCollectionError(source);
  assert.equal(mapped instanceof ApiContractError, true);
  assert.equal((mapped as ApiContractError).code, apiCode);
}

function apiError(code: ApiContractError["code"]): (error: unknown) => boolean {
  return (error) => error instanceof ApiContractError && error.code === code;
}

function request(
  body: unknown,
  headerOverrides: Readonly<Record<string, string>> = {},
): Request {
  return new Request("http://localhost/api/v1/cases", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "case-key-1",
      ...headerOverrides,
    },
    body: JSON.stringify(body),
  });
}
