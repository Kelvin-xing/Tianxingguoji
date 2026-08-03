import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

interface ResidencyResource {
  readonly id: string;
  readonly sensitive: boolean;
  readonly region?: string;
  readonly public_access: boolean;
  readonly replication_regions: readonly string[];
}

interface PolicyViolation {
  readonly code: string;
  readonly resource_id: string;
}

const POLICY_PATH = fileURLToPath(
  new URL("../../infra/terraform/policies/residency.rego", import.meta.url),
);
const OPA_PROBE = spawnSync("opa", ["version"], { encoding: "utf8" });
const OPA_AVAILABLE = OPA_PROBE.status === 0;

test("has the OPA evaluator required for residency policy verification", () => {
  assert.equal(
    OPA_AVAILABLE,
    true,
    OPA_PROBE.error?.message ?? OPA_PROBE.stderr ?? "OPA did not exit successfully",
  );
});

test("allows private sensitive resources confined to AWS Hong Kong", { skip: !OPA_AVAILABLE }, () => {
  assert.deepEqual(
    evaluatePolicy([
      privateHongKongResource("runtime"),
      privateHongKongResource("database"),
      privateHongKongResource("document-store"),
    ]),
    [],
  );
});

test("rejects a sensitive resource outside ap-east-1", { skip: !OPA_AVAILABLE }, () => {
  assert.deepEqual(
    evaluatePolicy([{ ...privateHongKongResource("database"), region: "ap-southeast-1" }]),
    [{ code: "NON_HK_REGION", resource_id: "database" }],
  );
});

test("rejects a sensitive resource with public access", { skip: !OPA_AVAILABLE }, () => {
  assert.deepEqual(
    evaluatePolicy([{ ...privateHongKongResource("document-store"), public_access: true }]),
    [{ code: "PUBLIC_EXPOSURE", resource_id: "document-store" }],
  );
});

test("rejects any cross-region replication for a sensitive resource", { skip: !OPA_AVAILABLE }, () => {
  assert.deepEqual(
    evaluatePolicy([
      {
        ...privateHongKongResource("document-store"),
        replication_regions: ["ap-southeast-1"],
      },
    ]),
    [{ code: "CROSS_REGION_REPLICATION", resource_id: "document-store" }],
  );
});

test("rejects a sensitive resource whose region is missing", { skip: !OPA_AVAILABLE }, () => {
  const resource = privateHongKongResource("scanner") as {
    region?: string;
  } & ResidencyResource;
  delete resource.region;

  assert.deepEqual(evaluatePolicy([resource]), [
    { code: "MISSING_REGION", resource_id: "scanner" },
  ]);
});

test(
  "does not apply sensitive-resource controls to an explicitly public non-sensitive asset",
  { skip: !OPA_AVAILABLE },
  () => {
  assert.deepEqual(
    evaluatePolicy([
      {
        id: "public-static-assets",
        sensitive: false,
        public_access: true,
        replication_regions: [],
      },
    ]),
    [],
    );
  },
);

function privateHongKongResource(id: string): ResidencyResource {
  return {
    id,
    sensitive: true,
    region: "ap-east-1",
    public_access: false,
    replication_regions: [],
  };
}

function evaluatePolicy(resources: readonly ResidencyResource[]): PolicyViolation[] {
  const result = spawnSync(
    "opa",
    [
      "eval",
      "--format=json",
      "--stdin-input",
      "--data",
      POLICY_PATH,
      "data.tianxing.residency.deny",
    ],
    {
      encoding: "utf8",
      input: JSON.stringify({ resources }),
    },
  );

  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);

  const output = JSON.parse(result.stdout) as {
    result?: Array<{ expressions?: Array<{ value?: PolicyViolation[] }> }>;
  };
  const violations = output.result?.[0]?.expressions?.[0]?.value;
  assert.ok(Array.isArray(violations), "OPA did not return a violation set");

  return [...violations].sort((left, right) =>
    `${left.code}:${left.resource_id}`.localeCompare(`${right.code}:${right.resource_id}`),
  );
}
