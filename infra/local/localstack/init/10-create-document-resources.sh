#!/bin/sh
set -eu

bucket="${LOCALSTACK_S3_BUCKET:?LOCALSTACK_S3_BUCKET is required}"
queue="${LOCALSTACK_SQS_QUEUE:?LOCALSTACK_SQS_QUEUE is required}"
dlq="${LOCALSTACK_SQS_DLQ:?LOCALSTACK_SQS_DLQ is required}"
region="${AWS_DEFAULT_REGION:?AWS_DEFAULT_REGION is required}"

if ! awslocal s3api head-bucket --bucket "${bucket}" >/dev/null 2>&1; then
  awslocal s3api create-bucket \
    --bucket "${bucket}" \
    --create-bucket-configuration "LocationConstraint=${region}" >/dev/null
fi

awslocal s3api put-bucket-versioning \
  --bucket "${bucket}" \
  --versioning-configuration Status=Enabled >/dev/null

if ! awslocal sqs get-queue-url --queue-name "${dlq}" >/dev/null 2>&1; then
  awslocal sqs create-queue --queue-name "${dlq}" >/dev/null
fi

if ! awslocal sqs get-queue-url --queue-name "${queue}" >/dev/null 2>&1; then
  awslocal sqs create-queue --queue-name "${queue}" >/dev/null
fi

dlq_url="$(awslocal sqs get-queue-url --queue-name "${dlq}" --query QueueUrl --output text)"
dlq_arn="$(awslocal sqs get-queue-attributes \
  --queue-url "${dlq_url}" \
  --attribute-names QueueArn \
  --query Attributes.QueueArn \
  --output text)"
queue_url="$(awslocal sqs get-queue-url --queue-name "${queue}" --query QueueUrl --output text)"
redrive_attributes="$(printf \
  '{"RedrivePolicy":"{\\"deadLetterTargetArn\\":\\"%s\\",\\"maxReceiveCount\\":\\"3\\"}"}' \
  "${dlq_arn}")"

awslocal sqs set-queue-attributes \
  --queue-url "${queue_url}" \
  --attributes "${redrive_attributes}" >/dev/null
