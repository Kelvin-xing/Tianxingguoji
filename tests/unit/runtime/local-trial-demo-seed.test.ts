import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  getLocalTrialDemoPrincipal,
  LOCAL_TRIAL_DEMO_PRINCIPALS,
} from "../../../modules/identity/infrastructure/local-trial-demo-principals.ts";
import { isLocalSyntheticRole } from "../../../modules/identity/infrastructure/local-synthetic-login.ts";

test("local trial demo aliases resolve to actual trial grades and fixed categories", () => {
  assert.deepEqual(LOCAL_TRIAL_DEMO_PRINCIPALS.map((principal) => principal.loginRole), [
    "l1", "l2_international", "l2_local", "l3",
  ]);
  assert.equal(getLocalTrialDemoPrincipal("l2_international").role, "l2");
  assert.deepEqual(getLocalTrialDemoPrincipal("l2_international").categories, ["international_school"]);
  assert.equal(getLocalTrialDemoPrincipal("l2_local").role, "l2");
  assert.equal(getLocalTrialDemoPrincipal("l3").role, "l3");
  assert.equal(isLocalSyntheticRole("l2_international"), true);
  assert.equal(isLocalSyntheticRole("not-a-demo-role"), false);
});

test("local trial demo seed is local-only and uses fixed synthetic data", async () => {
  const source = await readFile("scripts/db/seed-local-trial-demo.ts", "utf8");
  assert.match(source, /loadLocalSyntheticConfig/);
  assert.match(source, /LOCAL-TRIAL-INTERNATIONAL/);
  assert.match(source, /LOCAL-TRIAL-LOCAL/);
  assert.doesNotMatch(source, /production-aws|DATABASE_HOST|S3_BUCKET/);
});
