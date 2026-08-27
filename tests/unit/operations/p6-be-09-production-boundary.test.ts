import assert from "node:assert/strict";
import test from "node:test";
import { ProductionBoundaryError, loadProductionAdapterConfig, markCloudSynthetic, validateProductionAdapterConfig, validateReadinessInput } from "../../../modules/operations/domain/p6-be-09-production-boundary.ts";
import { createCloudSyntheticComposition, createProductionAwsComposition } from "../../../modules/operations/infrastructure/production-aws-composition.ts";

test("P6-BE-09 production configuration fails closed", async () => {
  assert.equal(validateProductionAdapterConfig({ mode: "production-aws", appEnvironment: "production", region: "ap-east-1", adapterKind: "aws-s3" }).region, "ap-east-1");
  assert.equal(loadProductionAdapterConfig({ APP_RUNTIME_MODE: "production-aws", APP_ENV: "production", AWS_REGION: "ap-east-1", P6_ADAPTER_KIND: "aws-s3" }).adapterKind, "aws-s3");
  for (const input of [
    { mode: "production-aws", appEnvironment: "production", region: "us-east-1", adapterKind: "aws-s3" },
    { mode: "production-aws", appEnvironment: "production", region: "ap-east-1", adapterKind: "gcp-storage" },
  ]) assert.throws(() => validateProductionAdapterConfig(input as never), ProductionBoundaryError);
  assert.throws(() => loadProductionAdapterConfig({ APP_RUNTIME_MODE: "cloud-synthetic", APP_ENV: "production", AWS_REGION: "ap-east-1", P6_ADAPTER_KIND: "synthetic" }), ProductionBoundaryError);
  assert.deepEqual(markCloudSynthetic({ ok: true }), { mode: "cloud-synthetic", simulated: true, value: { ok: true } });
  const config = { mode: "cloud-synthetic" as const, appEnvironment: "test" as const, region: "local", adapterKind: "synthetic" as const };
  assert.doesNotThrow(() => validateReadinessInput({ config, dependencies: ["database"] }));
  assert.equal((await createCloudSyntheticComposition(config).readiness({ config, dependencies: ["database"] })).simulated, true);
  await assert.rejects(() => createProductionAwsComposition({ mode: "production-aws", appEnvironment: "production", region: "ap-east-1", adapterKind: "aws-s3" }).readiness({ config: { mode: "production-aws", appEnvironment: "production", region: "ap-east-1", adapterKind: "aws-s3" }, dependencies: ["database"] }), (error: unknown) => error instanceof ProductionBoundaryError && error.code === "PRODUCTION_COMPOSITION_UNAVAILABLE");
});
