import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

function source(path: string): string {
  return readFileSync(new URL(path, `file://${ROOT}`), "utf8");
}

test("production fixes the approved Hong Kong private network inventory", () => {
  const main = source("infra/terraform/environments/production/main.tf");
  const variables = source("infra/terraform/environments/production/variables.tf");
  const network = source("infra/terraform/modules/network/main.tf") +
    source("infra/terraform/modules/network/production-nat.tf");
  const networkOutputs = source("infra/terraform/modules/network/outputs.tf");

  assert.match(main, /region\s*=\s*"ap-east-1"/);
  assert.match(main, /availability_zone_count\s*=\s*2/);
  assert.match(main, /enable_nat_gateway\s*=\s*true/);
  for (const endpoint of ["ecr.api", "ecr.dkr", "logs", "sqs", "kms", "secretsmanager", "sts"]) {
    assert.equal((main + network).includes(`"${endpoint}"`), true, `missing ${endpoint} endpoint`);
  }
  assert.match(network, /resource\s+"aws_nat_gateway"/);
  assert.match(network, /for_each\s*=\s*var\.enable_nat_gateway/);
  assert.match(network, /nat_gateway_id\s*=\s*aws_nat_gateway\.this\[each\.key\]\.id/);
  assert.match(networkOutputs, /output\s+"interface_endpoint_security_group_id"/);
  assert.match(main, /interface_endpoint_security_group_id\s*=\s*module\.network\.interface_endpoint_security_group_id/);
  assert.doesNotMatch(network, /aws_vpc_security_group_ingress_rule/);
  assert.doesNotMatch(network, /interface_endpoint_https/);
  assert.match(variables, /variable\s+"vpc_cidr"/);
  assert.doesNotMatch(variables, /variable\s+"vpc_cidr"[\s\S]{0,220}default\s*=/);
  assert.match(variables, /RFC1918 production VPC CIDR/);
  assert.match(variables, /\(1\[6-9\]\|20\)/);
  assert.match(variables, /health_ingress_cidrs requires canonical bounded IPv4 CIDRs/);
  assert.match(variables, /\(\[2-9\]\|\[12\]\[0-9\]\|3\[0-2\]\)/);
  assert.doesNotMatch(variables, /\(\[01\]\|\[12\]\[0-9\]\|3\[0-2\]\)/);
});

test("production fixes runtime, database, storage, WAF, logs, and bounded scaling", () => {
  const main = source("infra/terraform/environments/production/main.tf");
  const runtime = source("infra/terraform/modules/web-runtime/main.tf") +
    source("infra/terraform/modules/web-runtime/production-controls.tf");
  const rds = source("infra/terraform/modules/rds/main.tf");
  const documents = source("infra/terraform/modules/document-store/main.tf");

  assert.match(main, /task_cpu\s*=\s*1024/);
  assert.match(main, /task_memory\s*=\s*2048/);
  assert.match(main, /desired_count\s*=\s*2/);
  assert.match(main, /minimum_count\s*=\s*2/);
  assert.match(main, /maximum_count\s*=\s*4/);
  assert.match(runtime, /aws_appautoscaling_target/);
  assert.match(runtime, /deregistration_delay\s*=\s*30/);
  assert.match(runtime, /AWSManagedRulesCommonRuleSet/);
  assert.match(runtime, /AWSManagedRulesKnownBadInputsRuleSet/);
  assert.match(runtime, /var\.waf_rate_limit/);
  assert.match(runtime, /resource\s+"aws_vpc_security_group_ingress_rule"\s+"interface_endpoints_from_runtime"/);
  assert.match(runtime, /security_group_id\s*=\s*var\.interface_endpoint_security_group_id[\s\S]*referenced_security_group_id\s*=\s*aws_security_group\.runtime\.id/);
  assert.match(runtime, /resource\s+"aws_vpc_security_group_egress_rule"\s+"runtime_to_interface_endpoints"/);
  assert.match(runtime, /referenced_security_group_id\s*=\s*var\.interface_endpoint_security_group_id/);
  assert.doesNotMatch(runtime, /runtime_to_private_https|runtime_to_private_postgresql/);
  assert.match(rds, /resource\s+"aws_vpc_security_group_egress_rule"\s+"application_postgresql"/);
  assert.match(rds, /security_group_id\s*=\s*var\.application_security_group_id[\s\S]*referenced_security_group_id\s*=\s*aws_security_group\.database\.id/);
  assert.doesNotMatch(runtime, /AmazonECSTaskExecutionRolePolicy/);
  assert.match(runtime, /data\s+"aws_iam_policy_document"\s+"task_execution"/);
  assert.match(runtime, /ecr:GetAuthorizationToken/);
  assert.match(runtime, /resources\s*=\s*\["\*"\]/);
  for (const action of [
    "ecr:BatchCheckLayerAvailability",
    "ecr:BatchGetImage",
    "ecr:GetDownloadUrlForLayer",
  ]) {
    assert.match(runtime, new RegExp(action.replace(":", "\\:")));
  }
  assert.match(runtime, /resources\s*=\s*\[var\.container_repository_arn\]/);
  assert.match(runtime, /logs:CreateLogStream/);
  assert.match(runtime, /logs:PutLogEvents/);
  assert.match(runtime, /resources\s*=\s*\["\$\{aws_cloudwatch_log_group\.application\.arn\}:\*"\]/);
  assert.match(main, /container_repository_arn\s*=\s*var\.container_repository_arn/);
  assert.match(rds, /engine_version\s*=\s*var\.postgres_engine_version/);
  assert.match(rds, /instance_class\s*=\s*"db\.t4g\.small"/);
  assert.match(rds, /allocated_storage\s*=\s*20/);
  assert.match(rds, /storage_type\s*=\s*"gp3"/);
  assert.match(rds, /multi_az\s*=\s*true/);
  assert.match(rds, /backup_retention_period\s*=\s*7/);
  assert.match(rds, /deletion_protection\s*=\s*true/);
  assert.match(documents, /status\s*=\s*"Enabled"/);
  assert.match(documents, /sse_algorithm\s*=\s*"aws:kms"/);
  assert.match(documents, /resource\s+"aws_sqs_queue"\s+"scan_dead_letter"/);
  assert.match(main, /application_log_retention_days\s*=\s*30/);
  assert.match(main, /audit_log_retention_days\s*=\s*365/);
});

test("production deployment identity and routing values are external and have no defaults", () => {
  const variables = source("infra/terraform/environments/production/variables.tf");
  const versions = source("infra/terraform/environments/production/versions.tf");
  for (const name of [
    "aws_account_id",
    "vpc_cidr",
    "health_ingress_cidrs",
    "certificate_arn",
    "container_image_digest",
    "container_repository_arn",
    "document_bucket_name",
    "budget_notification_recipients",
    "waf_rate_limit",
  ]) {
    const block = variables.match(new RegExp(`variable\\s+"${name}"\\s*\\{([\\s\\S]*?)\\n\\}`));
    assert.ok(block, `missing required variable ${name}`);
    assert.doesNotMatch(block[1], /\bdefault\s*=/, `${name} must not have a production default`);
  }
  assert.match(variables, /container_image_digest[\s\S]*@sha256:/);
  assert.match(variables, /container_repository_arn[\s\S]*arn:aws:ecr:ap-east-1:\$\{var\.aws_account_id\}:repository/);
  assert.match(variables, /certificate_arn[\s\S]*arn:aws:acm:ap-east-1:\$\{var\.aws_account_id\}:certificate/);
  assert.match(variables, /log_kms_key_id[\s\S]*arn:aws:kms:ap-east-1:\$\{var\.aws_account_id\}:key/);
  assert.match(variables, /certificate\/\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}/);
  assert.match(variables, /key\/\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}/);
  assert.match(variables, /budget_notification_recipients[\s\S]*length\(var\.budget_notification_recipients\)\s*>\s*0/);
  assert.doesNotMatch(variables, /\bdefault\s*=/);
  assert.match(versions, /backend\s+"s3"/);
  assert.doesNotMatch(versions, /\bbucket\s*=/);
  assert.doesNotMatch(versions, /\bkey\s*=/);
});

test("production identity and category budgets encode the approved operating guardrails", () => {
  const identity = source("infra/terraform/environments/production/identity.tf");
  const budgets = source("infra/terraform/environments/production/budgets.tf");

  assert.match(identity, /resource\s+"aws_cognito_user_pool"/);
  assert.match(identity, /mfa_configuration\s*=\s*"ON"/);
  assert.match(identity, /software_token_mfa_configuration/);
  assert.match(identity, /account_recovery_setting[\s\S]*name\s*=\s*"admin_only"[\s\S]*priority\s*=\s*1/);
  assert.match(identity, /admin_create_user_config[\s\S]*allow_admin_create_user_only\s*=\s*true/);
  assert.match(identity, /deletion_protection\s*=\s*"ACTIVE"/);
  assert.match(identity, /prevent_user_existence_errors\s*=\s*"ENABLED"/);
  for (const category of ["compute", "database", "storage", "network"]) {
    assert.match(budgets, new RegExp(`${category}\\s*=`));
  }
  assert.match(budgets, /budget_thresholds\s*=\s*\[50, 80, 100\]/);
  assert.match(budgets, /subscriber_email_addresses\s*=\s*var\.budget_notification_recipients/);
});
