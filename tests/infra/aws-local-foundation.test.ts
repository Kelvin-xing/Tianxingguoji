import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

async function source(relativePath: string): Promise<string> {
  return readFile(new URL(relativePath, `file://${ROOT}`), "utf8");
}

test("Next.js production config selects standalone output and rejects missing build identity", async () => {
  const config = await source("next.config.ts");

  assert.match(config, /output:\s*["']standalone["']/);
  assert.match(config, /generateBuildId/);
  assert.match(config, /deploymentId/);
  assert.match(config, /GIT_SHA/);
  assert.match(config, /NEXT_DEPLOYMENT_ID/);
  assert.match(config, /VERCEL_GIT_COMMIT_SHA/);
  assert.match(config, /VERCEL_DEPLOYMENT_ID/);
  assert.match(config, /isProduction && !value/);
  assert.match(config, /GIT_SHA_PATTERN\s*=\s*\/\^\[0-9a-f\]\{7,64\}\$\//);
  assert.match(config, /DEPLOYMENT_ID_PATTERN/);
});

test("Next.js production config accepts Vercel build identities", () => {
  const result = loadNextConfig({
    VERCEL_GIT_COMMIT_SHA: "2d8b461",
    VERCEL_DEPLOYMENT_ID: "dpl_test-123",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    buildId: "2d8b461",
    deploymentId: "dpl_test-123",
  });
});

test("explicit build identities override Vercel values", () => {
  const result = loadNextConfig({
    GIT_SHA: "abcdef0123456789",
    NEXT_DEPLOYMENT_ID: "aws-production-42",
    VERCEL_GIT_COMMIT_SHA: "2d8b461",
    VERCEL_DEPLOYMENT_ID: "dpl_test-123",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    buildId: "abcdef0123456789",
    deploymentId: "aws-production-42",
  });
});

test("Next.js production config still fails closed without any build identity", () => {
  const result = loadNextConfig({});

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /GIT_SHA is required for a production multi-instance build/);
});

function loadNextConfig(
  values: Readonly<Record<string, string>>,
): Readonly<{ status: number | null; stdout: string; stderr: string }> {
  const configUrl = new URL("next.config.ts", `file://${ROOT}`).href;
  const script = [
    `const { default: config } = await import(${JSON.stringify(configUrl)});`,
    "const buildId = await config.generateBuildId();",
    "process.stdout.write(JSON.stringify({ buildId, deploymentId: config.deploymentId }));",
  ].join("\n");
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "production",
    ...values,
  };
  for (const name of [
    "GIT_SHA",
    "NEXT_DEPLOYMENT_ID",
    "VERCEL_GIT_COMMIT_SHA",
    "VERCEL_DEPLOYMENT_ID",
  ]) {
    if (!(name in values)) delete environment[name];
  }
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: ROOT,
    encoding: "utf8",
    env: environment,
  });
  return Object.freeze({
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  });
}

test("Dockerfile is a fail-closed standalone build contract", async () => {
  const [dockerfile, dockerignore] = await Promise.all([
    source("Dockerfile"),
    source(".dockerignore"),
  ]);

  assert.match(dockerfile, /^ARG NODE_IMAGE$/m);
  assert.match(dockerfile, /^FROM \$\{NODE_IMAGE\} AS dependencies$/m);
  assert.match(dockerfile, /node:\[A-Za-z0-9\._-\]\+-alpine\[A-Za-z0-9\._-\]\*@sha256:\[0-9a-f\]\{64\}/);
  assert.match(dockerfile, /pnpm install --frozen-lockfile/);
  assert.match(dockerfile, /\.next\/standalone/);
  assert.match(dockerfile, /\.next\/static/);
  assert.match(dockerfile, /USER 10001:10001/);
  assert.match(dockerfile, /type=secret,id=next_server_actions_encryption_key,required=true/);
  assert.match(dockerfile, /NEXT_SERVER_ACTIONS_ENCRYPTION_KEY/);
  assert.match(dockerfile, /CMD \["node", "server\.js"\]/);
  assert.doesNotMatch(dockerfile, /^FROM node:(?:latest|20|22)(?:\s|$)/m);
  assert.match(dockerignore, /^\.env\*$/m);
  assert.match(dockerignore, /^node_modules$/m);
  assert.match(dockerignore, /^\.next$/m);
});

test("production wires the authenticated private runtime contract", async () => {
  const [main, variables, outputs, runtime, controls] = await Promise.all([
    source("infra/terraform/environments/production/main.tf"),
    source("infra/terraform/environments/production/variables.tf"),
    source("infra/terraform/environments/production/outputs.tf"),
    source("infra/terraform/modules/web-runtime/main.tf"),
    source("infra/terraform/modules/web-runtime/production-controls.tf"),
  ]);

  assert.match(main, /runtime_mode\s*=\s*"production-authenticated"/);
  assert.match(main, /health_ingress_cidrs\s*=\s*var\.health_ingress_cidrs/);
  assert.match(main, /alb_ingress_cidrs\s*=\s*var\.alb_ingress_cidrs/);
  assert.match(main, /build_git_sha\s*=\s*var\.build_git_sha/);
  assert.match(main, /deployment_id\s*=\s*var\.deployment_id/);
  assert.match(main, /enable_deletion_protection\s*=\s*true/);
  assert.match(variables, /variable\s+"alb_ingress_cidrs"/);
  assert.match(variables, /variable\s+"build_git_sha"/);
  assert.match(variables, /variable\s+"deployment_id"/);
  assert.doesNotMatch(variables, /variable\s+"alb_ingress_cidrs"[\s\S]*?default\s*=/);
  assert.doesNotMatch(variables, /variable\s+"build_git_sha"[\s\S]*?default\s*=/);
  assert.doesNotMatch(variables, /variable\s+"deployment_id"[\s\S]*?default\s*=/);
  assert.match(runtime, /local\.is_production \? var\.alb_ingress_cidrs/);
  assert.match(runtime, /assign_public_ip\s*=\s*false/);
  assert.match(runtime, /readonlyRootFilesystem\s*=\s*true/);
  assert.match(runtime, /stopTimeout\s*=\s*30/);
  assert.match(runtime, /platform_version\s*=\s*local\.is_production \? "LATEST"/);
  assert.match(runtime, /deployment_minimum_healthy_percent\s*=\s*local\.is_production \? 100/);
  assert.match(runtime, /deployment_maximum_percent\s*=\s*local\.is_production \? 200/);
  assert.match(runtime, /mode\s*=\s*"blocking"/);
  assert.match(runtime, /enable_deletion_protection\s*=\s*var\.enable_deletion_protection/);
  assert.match(runtime, /aws:SourceAccount/);
  assert.match(runtime, /aws:SourceArn/);
  assert.match(runtime, /approved_repository_url/);
  assert.match(runtime, /exact approved ECR repository/);
  assert.match(runtime, /length\(distinct\(var\.private_subnet_ids\)\)\s*>=\s*2/);
  assert.match(runtime, /var\.enable_production_controls/);
  assert.match(runtime, /var\.application_log_retention_days\s*==\s*30/);
  assert.match(runtime, /var\.audit_log_retention_days\s*==\s*365/);
  assert.match(runtime, /application_all/);
  assert.match(runtime, /values\s*=\s*\["\/\*"\]/);
  assert.match(controls, /AWSManagedRulesCommonRuleSet/);
  assert.match(controls, /AWSManagedRulesKnownBadInputsRuleSet/);
  assert.match(controls, /var\.waf_rate_limit/);
  assert.match(outputs, /production_region/);
  assert.match(outputs, /runtime_mode/);
});

test("staging remains on the health-only module mode", async () => {
  const [main, variables] = await Promise.all([
    source("infra/terraform/environments/staging/main.tf"),
    source("infra/terraform/modules/web-runtime/variables.tf"),
  ]);

  assert.doesNotMatch(main, /runtime_mode\s*=\s*"production-authenticated"/);
  assert.match(variables, /default\s*=\s*"staging-health"/);
});
