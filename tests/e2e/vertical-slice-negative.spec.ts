import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));

const AUTHORIZATION_AND_CONCURRENCY_SUITES = [
  "tests/integration/case-creation-workflow.test.ts",
  "tests/integration/collaborator-scope-workflow.test.ts",
  "tests/integration/assessment-workflow.test.ts",
  "tests/integration/school-change-workflow.test.ts",
  "tests/integration/school-target-workflow.test.ts",
  "tests/integration/task-workflow.test.ts",
  "tests/integration/document-upload-workflow.test.ts",
  "tests/integration/document-version-workflow.test.ts",
  "tests/integration/case-transition-workflow.test.ts",
] as const;

const REQUIRED_CASE_TITLES = [
  "inactive Advisor binding, unapproved manifest, and non-Advisor actor are denied",
  "a Primary Advisor revokes a scope immediately with an optimistic version",
  "a sensitive scope persists pending approval and cannot authorize access",
  "an overlong scope and a non-Primary Advisor are denied without partial facts",
  "uses the answer version as a compare-and-set token instead of last-write-wins",
  "idempotency replay has no second effect and a transaction failure leaves no answer or effect",
  "exact idempotency replay returns the first change request and altered reuse is denied",
  "missing provisional facts, invalid evidence, and a stale immutable base are rejected before any effect is committed",
  "a target pointer based on an older resolved hash fails with a stale conflict",
  "disabling an approved revision creates a rollback view without rewriting an existing pin",
  "a cross-case Advisor and a non-reviewer are denied without disclosing or changing facts",
  "cross-case and unauthorized requests reveal no document fact",
  "expired replay and invalid checksum, size, or type are denied without partial facts",
  "stale versions, unsupported transitions, and missing reassign targets deny without an effect",
  "stale pointers and cross-case requests disclose no document fact or effect",
  "a repeated grant returns its first result, while changed key reuse is rejected",
  "case visibility, Primary Advisor authority, stale versions, and unsupported states deny",
] as const;

test("Release 1 negative vertical slice preserves denials, conflicts, replay boundaries, and provenance", () => {
  const result = runNodeTests(AUTHORIZATION_AND_CONCURRENCY_SUITES);
  const output = testOutput(result);

  assert.equal(result.status, 0, formatFailure(result));
  assert.match(output, /(?:#|\u2139) fail 0/);
  assertRequiredCases(output, REQUIRED_CASE_TITLES);
});

function runNodeTests(files: readonly string[]) {
  const childEnvironment = { ...process.env };
  // node:test prevents a child runner from inheriting this recursion marker.
  delete childEnvironment.NODE_TEST_CONTEXT;

  return spawnSync(process.execPath, ["--test", ...files], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    env: childEnvironment,
  });
}

function formatFailure(result: ReturnType<typeof runNodeTests>): string {
  return [result.error?.message, testOutput(result)].filter(Boolean).join("\n");
}

function testOutput(result: ReturnType<typeof runNodeTests>): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

function assertRequiredCases(output: string, titles: readonly string[]): void {
  for (const title of titles) {
    assert.ok(output.includes(title), `Required negative contract did not run: ${title}`);
  }
}
