import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

interface Manifest {
  version: string;
  status: string;
  cases: Array<{ id: string; suite: string; testName: string }>;
}
const required = ["unauthorized_access", "stale_write", "replay", "unknown_commit", "scan_failure", "outbox_failure", "revoke_after_claim", "telemetry_sink_failure"];

test("P3-16 failure manifest is complete and points only to local suites", async () => {
  const manifest = JSON.parse(await readFile("tests/fixtures/release1/phase3/p3-16-failure-manifest.json", "utf8")) as Manifest;
  assert.equal(manifest.version, "p3-16.v1");
  assert.equal(manifest.status, "source_only_not_release_evidence");
  assert.deepEqual(manifest.cases.map(({ id }) => id).sort(), [...required].sort());
  for (const entry of manifest.cases) {
    assert.match(entry.suite, /^tests\/(?:e2e|integration|failure-injection)\/[a-z0-9-]+\.(?:spec|test)\.ts$/);
    const source = await readFile(entry.suite, "utf8");
    const selector = `test(${JSON.stringify(entry.testName)}`;
    assert.equal(source.split(selector).length - 1, 1, `${entry.id} must bind one stable test name`);
  }
});

test("P3-16 production security/reliability receipt", {
  skip: process.env.P3_SECURITY_RUNTIME_APPROVED === "true"
    ? false
    : "No exact P3-12 through P3-15 runtime approval/receipt was supplied.",
}, () => {
  assert.fail("Production failure injection requires an approved external harness and Security sign-off.");
});
