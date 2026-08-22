import assert from "node:assert/strict";
import test from "node:test";

import { mapStudentReadError } from "../../app/api/v1/student-read-handler.ts";
import { ApiContractError } from "../../modules/shared/public.ts";

test("list and detail map cross-module Student read denial to FORBIDDEN", () => {
  const denial = equivalentError("STUDENT_READ_FORBIDDEN");
  for (const endpoint of ["list", "detail"] as const) {
    const mapped = mapStudentReadError(denial, endpoint);
    assert.equal(mapped instanceof ApiContractError && mapped.code, "FORBIDDEN");
  }
});

test("detail maps invalid IDs to NOT_FOUND while list and unknown errors fail closed", () => {
  const invalidId = equivalentError("STUDENT_ID_INVALID");
  const detail = mapStudentReadError(invalidId, "detail");
  assert.equal(detail instanceof ApiContractError && detail.code, "NOT_FOUND");
  assert.strictEqual(mapStudentReadError(invalidId, "list"), invalidId);

  const unknownCode = equivalentError("UNKNOWN");
  const plainObject = Object.freeze({ name: "StudentReadError", code: "STUDENT_READ_FORBIDDEN" });
  assert.strictEqual(mapStudentReadError(unknownCode, "detail"), unknownCode);
  assert.strictEqual(mapStudentReadError(plainObject, "detail"), plainObject);
});

function equivalentError(code: string): Error {
  const error = new Error("redacted");
  error.name = "StudentReadError";
  Object.defineProperty(error, "code", { value: code, enumerable: true });
  return error;
}
