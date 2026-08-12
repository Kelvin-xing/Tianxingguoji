import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const MODULE_ROOT = new URL("../../infra/terraform/modules/document-store/", import.meta.url);

async function moduleFile(name: string): Promise<string> {
  return readFile(fileURLToPath(new URL(name, MODULE_ROOT)), "utf8");
}

test("document-store confines bucket, KMS, and queues to private ap-east-1 controls", async () => {
  const [main, variables, outputs] = await Promise.all([
    moduleFile("main.tf"),
    moduleFile("variables.tf"),
    moduleFile("outputs.tf"),
  ]);

  assert.match(main, /data "aws_region" "current"/);
  assert.match(main, /data\.aws_region\.current\.name == "ap-east-1"/);
  assert.match(main, /multi_region\s+=\s+false/);
  assert.match(main, /enable_key_rotation\s+=\s+true/);
  assert.match(main, /block_public_acls\s+=\s+true/);
  assert.match(main, /block_public_policy\s+=\s+true/);
  assert.match(main, /ignore_public_acls\s+=\s+true/);
  assert.match(main, /restrict_public_buckets\s+=\s+true/);
  assert.match(main, /object_ownership\s+=\s+"BucketOwnerEnforced"/);
  assert.match(main, /status\s+=\s+"Enabled"/);
  assert.match(main, /sse_algorithm\s+=\s+"aws:kms"/);
  assert.match(main, /bucket_key_enabled\s+=\s+true/);
  assert.match(main, /"kms:Decrypt"/);
  assert.match(main, /"kms:GenerateDataKey"/);
  assert.match(main, /kms:ViaService/);
  assert.match(main, /s3\.ap-east-1\.amazonaws\.com/);
  assert.match(main, /kms:EncryptionContext:aws:s3:arn/);
  assert.match(main, /test\s*=\s+"StringEquals"[\s\S]*variable\s*=\s+"kms:EncryptionContext:aws:s3:arn"[\s\S]*values\s*=\s+\[aws_s3_bucket\.documents\.arn\]/);
  assert.match(main, /resources\s*=\s+\["\$\{aws_s3_bucket\.documents\.arn\}\/documents\/\*"\]/);
  assert.match(main, /sqs\.ap-east-1\.amazonaws\.com/);
  assert.match(main, /kms:EncryptionContext:aws:sqs:arn/);
  assert.match(main, /document-scan/);
  assert.match(main, /document-scan-dlq/);
  assert.match(main, /DenyInsecureTransport/);
  assert.match(main, /DenyIncorrectObjectEncryptionAlgorithm/);
  assert.match(main, /DenyIncorrectObjectEncryptionKey/);
  assert.match(main, /test\s*=\s+"StringNotEqualsIfExists"/);
  assert.match(main, /variable\s*=\s+"s3:x-amz-server-side-encryption"/);
  assert.match(main, /values\s*=\s+\["aws:kms"\]/);
  assert.match(main, /variable\s*=\s+"s3:x-amz-server-side-encryption-aws-kms-key-id"/);
  assert.match(main, /values\s*=\s+\[aws_kms_key\.documents\.arn\]/);
  assert.match(main, /test\s*=\s+"Null"[\s\S]*values\s*=\s+\["false"\]/);
  assert.match(main, /events\s*=\s+\["s3:ObjectCreated:\*"\]/);
  assert.match(main, /filter_prefix\s*=\s+"documents\/"/);
  assert.match(main, /aws_s3_bucket_notification/);
  assert.match(main, /aws_sqs_queue" "scan_dead_letter"/);
  assert.match(main, /maxReceiveCount\s+=\s+3/);
  assert.match(main, /"s3:PutObject"/);
  assert.doesNotMatch(main, /aws_s3_bucket_replication_configuration/);
  assert.doesNotMatch(main, /aws_cloudfront_distribution/);
  assert.doesNotMatch(main, /aws_s3control_multi_region_access_point/);
  assert.match(variables, /variable "bucket_name"/);
  assert.match(variables, /variable "application_task_role_name"/);
  assert.match(outputs, /output "scan_queue_arn"/);
});
