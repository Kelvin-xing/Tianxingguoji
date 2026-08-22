import assert from "node:assert/strict";
import test from "node:test";

import { isStudentReadError } from "../../../modules/crm/application/read-service.ts";

test("stable StudentReadError guard accepts an equivalent Error from another module instance", () => {
  const crossModuleError = new Error("redacted");
  crossModuleError.name = "StudentReadError";
  Object.defineProperty(crossModuleError, "code", {
    value: "STUDENT_READ_FORBIDDEN",
    enumerable: true,
  });

  assert.equal(isStudentReadError(crossModuleError), true);
  assert.equal(isStudentReadError(crossModuleError, "STUDENT_READ_FORBIDDEN"), true);
  assert.equal(isStudentReadError(crossModuleError, "STUDENT_ID_INVALID"), false);
});

test("stable StudentReadError guard rejects plain objects and unknown codes", () => {
  assert.equal(isStudentReadError(Object.freeze({
    name: "StudentReadError",
    code: "STUDENT_READ_FORBIDDEN",
  })), false);
  const unknownCode = new Error("redacted");
  unknownCode.name = "StudentReadError";
  Object.defineProperty(unknownCode, "code", { value: "UNKNOWN" });
  assert.equal(isStudentReadError(unknownCode), false);
});
