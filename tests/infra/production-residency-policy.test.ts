import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const policy = fileURLToPath(new URL("../../infra/terraform/policies/residency.rego", import.meta.url));
const fixture = fileURLToPath(new URL("../fixtures/infra/production-residency.json", import.meta.url));

test("approved production sensitive-resource inventory passes the OPA residency policy", () => {
  const result = spawnSync("opa", [
    "eval", "--format=json", "--stdin-input", "--data", policy, "data.tianxing.residency.deny",
  ], { encoding: "utf8", input: readFileSync(fixture, "utf8") });

  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout) as {
    result?: Array<{ expressions?: Array<{ value?: unknown[] }> }>;
  };
  assert.deepEqual(parsed.result?.[0]?.expressions?.[0]?.value, []);
});
