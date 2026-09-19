import assert from "node:assert/strict";
import test from "node:test";
import { isP3TaskError, P3TaskError } from "../../../modules/tasks/application/p3-service.ts";

test("P3 errors from a retained runtime survive module constructor reloads", () => {
  class PreviousP3TaskError extends Error {
    readonly code = "NOT_FOUND";
    constructor() { super("Task unavailable"); this.name = "P3TaskError"; }
  }
  const previous = new PreviousP3TaskError();
  assert.equal(previous instanceof P3TaskError, false);
  assert.equal(isP3TaskError(previous), true);
  assert.equal(isP3TaskError(new P3TaskError("FORBIDDEN")), true);
  assert.equal(isP3TaskError({ name: "P3TaskError", code: "NOT_FOUND" }), false);
  assert.equal(isP3TaskError(Object.assign(new Error(), { name: "P3TaskError", code: "UNKNOWN" })), false);
  assert.equal(isP3TaskError(new Error("NOT_FOUND")), false);
});
