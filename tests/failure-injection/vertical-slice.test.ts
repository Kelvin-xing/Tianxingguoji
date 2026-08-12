import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));

const FAILURE_AND_WORKER_SUITES = [
  "tests/integration/case-creation-workflow.test.ts",
  "tests/integration/assessment-workflow.test.ts",
  "tests/integration/collaborator-scope-workflow.test.ts",
  "tests/integration/school-change-workflow.test.ts",
  "tests/integration/school-target-workflow.test.ts",
  "tests/integration/task-workflow.test.ts",
  "tests/integration/document-upload-workflow.test.ts",
  "tests/integration/document-version-workflow.test.ts",
  "tests/integration/case-transition-workflow.test.ts",
  "tests/integration/document-scan-workflow.test.ts",
  "tests/integration/in-app-notification-delivery.test.ts",
] as const;

const REQUIRED_CASE_TITLES = [
  "a repository failure leaves no partial Student, Case, audit, or outbox state",
  "idempotency replay has no second effect and a transaction failure leaves no answer or effect",
  "a repository failure commits no collaborator, grant, audit, or outbox fact",
  "a repository failure leaves submitted change, candidate overlay, audit, and outbox absent",
  "target idempotency replays once and injected failure leaves no target or effect",
  "idempotency replays one original transition and a pre-commit failure leaves no partial facts",
  "a transaction failure leaves version, idempotency, audit, and outbox empty",
  "a failed transaction preserves the old document pointer and has no partial durable facts",
  "a repository failure commits no scan state, work, audit, or outbox facts",
  "only a clean result can make a quarantined version available, and an exact duplicate scans once",
  "malicious output is rejected and never becomes downloadable",
  "bounded retry treats an exact replay as a duplicate and sends the third failure to DLQ",
  "reconciliation finds missed and stuck work without unsafe availability",
  "access revoked after claim suppresses a P1-14 effect immediately before delivery",
  "duplicate delivery of the same effect replays one receipt without a second notification",
  "bounded delivery failure reaches DLQ without reversing the producer fact",
  "one idempotency result replays, while a pre-commit failure leaves no case transition partial fact",
  "the document runtime fails closed without a configured HK RDS and S3 adapter",
  "the document version runtime fails closed without an HK RDS composition",
  "effects contain no object tuple, scanner detail, or document content and runtime fails closed",
  "unconfigured HK worker runtime fails closed",
] as const;

test("Release 1 injected failures create no partial durable effect and worker failures fail closed", () => {
  const result = runNodeTests(FAILURE_AND_WORKER_SUITES);
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
    assert.ok(output.includes(title), `Required failure contract did not run: ${title}`);
  }
}
