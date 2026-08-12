import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const INFRA_ROOT = fileURLToPath(new URL("../../infra/terraform/", import.meta.url));

function readTerraform(relativePath: string): string {
  return readFileSync(new URL(relativePath, `file://${INFRA_ROOT}`), "utf8");
}

test("staging wiring fixes sensitive runtime resources to Hong Kong and requires reviewed ingress", () => {
  const versions = readTerraform("environments/staging/versions.tf");
  const variables = readTerraform("environments/staging/variables.tf");
  const main = readTerraform("environments/staging/main.tf");
  const networkOutputs = readTerraform("modules/network/outputs.tf");

  assert.match(versions, /required_version/);
  assert.match(versions, /hashicorp\/aws/);
  assert.match(versions, /backend\s+"s3"\s*\{[\s\S]*region\s*=\s*"ap-east-1"/);
  assert.match(versions, /encrypt\s*=\s*true/);
  assert.match(versions, /use_lockfile\s*=\s*true/);
  assert.match(main, /region\s*=\s*"ap-east-1"/);
  assert.match(main, /source\s*=\s*"\.\.\/\.\.\/modules\/network"/);
  assert.match(main, /source\s*=\s*"\.\.\/\.\.\/modules\/web-runtime"/);
  assert.match(networkOutputs, /output\s+"interface_endpoint_security_group_id"/);
  assert.match(main, /interface_endpoint_security_group_id\s*=\s*module\.network\.interface_endpoint_security_group_id/);
  assert.match(variables, /variable\s+"health_ingress_cidrs"/);
  assert.match(variables, /health_ingress_cidrs must contain at least one approved CIDR/);
  assert.match(variables, /cidr != "0\.0\.0\.0\/0"/);
  assert.match(variables, /cidr != "::\/0"/);
  assert.equal(variables.includes('^10\\\\.[0-9]{1,3}\\\\.0\\\\.0/16$'), true);
  assert.match(variables, /variable\s+"container_repository_arn"/);
  assert.match(variables, /certificate\/\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}/);
  assert.match(variables, /key\/\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}/);
  assert.match(main, /container_repository_arn\s*=\s*var\.container_repository_arn/);
  assert.match(main, /tags\s*=\s*merge\(\s*var\.tags,[\s\S]*DataClass\s*=\s*"sensitive-runtime"/);
});

test("private network has no task internet route and uses only private AWS service endpoints", () => {
  const main = readTerraform("modules/network/main.tf");
  const privateRouteTable = main.slice(
    main.indexOf('resource "aws_route_table" "private"'),
    main.indexOf('resource "aws_route_table_association" "private"'),
  );

  assert.match(main, /enable_dns_hostnames\s*=\s*true/);
  assert.match(main, /aws_vpc_endpoint/);
  assert.match(main, /ecr\.api/);
  assert.match(main, /ecr\.dkr/);
  assert.match(main, /"logs"/);
  assert.match(main, /service_name\s*=\s*"com\.amazonaws\.\$\{var\.aws_region\}\.\$\{each\.value\}"/);
  assert.match(main, /vpc_endpoint_type\s*=\s*"Gateway"/);
  assert.match(main, /route_table_ids\s*=\s*values\(aws_route_table\.private\)\[\*\]\.id/);
  assert.doesNotMatch(main, /aws_nat_gateway/);
  assert.doesNotMatch(main, /aws_vpc_security_group_ingress_rule/);
  assert.doesNotMatch(main, /interface_endpoint_all/);
  assert.doesNotMatch(privateRouteTable, /gateway_id|nat_gateway_id/);
});

test("runtime accepts only GET health checks through the load balancer and keeps tasks private", () => {
  const main = readTerraform("modules/web-runtime/main.tf");
  const variables = readTerraform("modules/web-runtime/variables.tf");
  const rds = readTerraform("modules/rds/main.tf");
  const rdsVariables = readTerraform("modules/rds/variables.tf");

  assert.match(main, /assign_public_ip\s*=\s*false/);
  assert.match(main, /containerPort\s*=\s*3000/);
  assert.match(main, /health_check\s*\{[\s\S]*path\s*=\s*"\/api\/v1\/health"/);
  assert.match(main, /http_request_method\s*\{[\s\S]*values\s*=\s*\["GET"\]/);
  assert.match(main, /aws_lb_listener_rule/);
  assert.match(main, /path_pattern\s*\{[\s\S]*values\s*=\s*\["\/api\/v1\/health"\]/);
  assert.match(main, /data\s+"aws_prefix_list"\s+"s3"/);
  assert.match(main, /prefix_list_id\s*=\s*data\.aws_prefix_list\.s3\.id/);
  assert.match(main, /cidr_ipv4\s*=\s*"\$\{cidrhost\(var\.vpc_cidr, 2\)\}\/32"/);
  assert.match(main, /retention_in_days\s*=\s*30/);
  assert.match(main, /readonlyRootFilesystem\s*=\s*true/);
  assert.match(main, /drop\s*=\s*\["ALL"\]/);
  assert.match(main, /add\s*=\s*\["NET_BIND_SERVICE"\]/);
  assert.match(main, /fixed_response\s*\{[\s\S]*status_code\s*=\s*"404"/);
  assert.match(main, /resource\s+"aws_vpc_security_group_ingress_rule"\s+"interface_endpoints_from_runtime"/);
  assert.match(main, /security_group_id\s*=\s*var\.interface_endpoint_security_group_id[\s\S]*referenced_security_group_id\s*=\s*aws_security_group\.runtime\.id/);
  assert.match(main, /resource\s+"aws_vpc_security_group_egress_rule"\s+"runtime_to_interface_endpoints"/);
  assert.match(main, /referenced_security_group_id\s*=\s*var\.interface_endpoint_security_group_id/);
  assert.doesNotMatch(main, /runtime_to_private_https|runtime_to_private_postgresql/);
  assert.match(rds, /resource\s+"aws_vpc_security_group_egress_rule"\s+"application_postgresql"/);
  assert.match(rdsVariables, /key\/\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}/);
  assert.doesNotMatch(main, /AmazonECSTaskExecutionRolePolicy/);
  assert.match(main, /data\s+"aws_iam_policy_document"\s+"task_execution"/);
  assert.match(main, /ecr:GetAuthorizationToken/);
  assert.match(main, /resources\s*=\s*\["\*"\]/);
  assert.match(main, /resources\s*=\s*\[var\.container_repository_arn\]/);
  assert.match(main, /resources\s*=\s*\["\$\{aws_cloudwatch_log_group\.application\.arn\}:\*"\]/);
  assert.match(variables, /variable\s+"container_repository_arn"/);
  assert.match(variables, /enable_production_controls[\s\S]*default\s*=\s*false/);
  assert.doesNotMatch(main, /enable_production_controls\s*=\s*true/);
  assert.doesNotMatch(main, /DATABASE_URL|SECRET|secretsmanager|aws_secretsmanager/);
});
