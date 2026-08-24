#!/bin/sh
set -eu

bucket="${LOCALSTACK_S3_BUCKET:?LOCALSTACK_S3_BUCKET is required}"
queue="${LOCALSTACK_SQS_QUEUE:?LOCALSTACK_SQS_QUEUE is required}"
dlq="${LOCALSTACK_SQS_DLQ:?LOCALSTACK_SQS_DLQ is required}"
region="${AWS_DEFAULT_REGION:?AWS_DEFAULT_REGION is required}"
browser_origin="${LOCALSTACK_BROWSER_ORIGIN:?LOCALSTACK_BROWSER_ORIGIN is required}"
queue_visibility_timeout="180"

case "${browser_origin}" in
  http://127.0.0.1:*|http://localhost:*) ;;
  *)
    echo "LOCALSTACK_BROWSER_ORIGIN must be an explicit loopback HTTP origin" >&2
    exit 1
    ;;
esac

browser_port="${browser_origin##*:}"
case "${browser_port}" in
  ""|*[!0-9]*)
    echo "LOCALSTACK_BROWSER_ORIGIN must include a numeric port" >&2
    exit 1
    ;;
esac
if [ "${#browser_port}" -gt 5 ] || [ "${browser_port}" -lt 1 ] || [ "${browser_port}" -gt 65535 ]; then
  echo "LOCALSTACK_BROWSER_ORIGIN port is outside the allowed range" >&2
  exit 1
fi

cors_configuration_file=""
queue_policy_attributes_file=""
notification_configuration_file=""

cleanup() {
  [ -z "${cors_configuration_file}" ] || rm -f "${cors_configuration_file}"
  [ -z "${queue_policy_attributes_file}" ] || rm -f "${queue_policy_attributes_file}"
  [ -z "${notification_configuration_file}" ] || rm -f "${notification_configuration_file}"
}
trap cleanup EXIT HUP INT TERM

if ! awslocal s3api head-bucket --bucket "${bucket}" >/dev/null 2>&1; then
  awslocal s3api create-bucket \
    --bucket "${bucket}" \
    --create-bucket-configuration "LocationConstraint=${region}" >/dev/null
fi

awslocal s3api put-bucket-versioning \
  --bucket "${bucket}" \
  --versioning-configuration Status=Enabled >/dev/null

cors_configuration_file="$(mktemp)"
cat >"${cors_configuration_file}" <<EOF
{"CORSRules":[{"ID":"local-browser-document-transfer","AllowedHeaders":["content-type","x-amz-checksum-sha256"],"AllowedMethods":["GET","HEAD","PUT"],"AllowedOrigins":["${browser_origin}"],"MaxAgeSeconds":300}]}
EOF

awslocal s3api put-bucket-cors \
  --bucket "${bucket}" \
  --cors-configuration "file://${cors_configuration_file}" >/dev/null

if ! awslocal sqs get-queue-url --queue-name "${dlq}" >/dev/null 2>&1; then
  awslocal sqs create-queue --queue-name "${dlq}" >/dev/null
fi

if ! awslocal sqs get-queue-url --queue-name "${queue}" >/dev/null 2>&1; then
  awslocal sqs create-queue \
    --queue-name "${queue}" \
    --attributes "VisibilityTimeout=${queue_visibility_timeout}" >/dev/null
fi

dlq_url="$(awslocal sqs get-queue-url --queue-name "${dlq}" --query QueueUrl --output text)"
dlq_arn="$(awslocal sqs get-queue-attributes \
  --queue-url "${dlq_url}" \
  --attribute-names QueueArn \
  --query Attributes.QueueArn \
  --output text)"
queue_url="$(awslocal sqs get-queue-url --queue-name "${queue}" --query QueueUrl --output text)"
queue_arn="$(awslocal sqs get-queue-attributes \
  --queue-url "${queue_url}" \
  --attribute-names QueueArn \
  --query Attributes.QueueArn \
  --output text)"
account_id="$(printf '%s\n' "${queue_arn}" | cut -d: -f5)"

case "${account_id}" in
  ""|*[!0-9]*)
    echo "LocalStack returned an invalid queue account identifier" >&2
    exit 1
    ;;
esac
if [ "${#account_id}" -ne 12 ] || [ "${queue_arn}" != "arn:aws:sqs:${region}:${account_id}:${queue}" ]; then
  echo "LocalStack returned an unexpected document queue ARN" >&2
  exit 1
fi
if [ "${dlq_arn}" != "arn:aws:sqs:${region}:${account_id}:${dlq}" ]; then
  echo "LocalStack returned an unexpected document DLQ ARN" >&2
  exit 1
fi

queue_attributes="$(printf \
  '{"RedrivePolicy":"{\\"deadLetterTargetArn\\":\\"%s\\",\\"maxReceiveCount\\":\\"3\\"}","VisibilityTimeout":"%s"}' \
  "${dlq_arn}" \
  "${queue_visibility_timeout}")"

awslocal sqs set-queue-attributes \
  --queue-url "${queue_url}" \
  --attributes "${queue_attributes}" >/dev/null

queue_policy_attributes_file="$(mktemp)"
cat >"${queue_policy_attributes_file}" <<EOF
{"Policy":"{\"Version\":\"2012-10-17\",\"Statement\":[{\"Sid\":\"AllowExactDocumentBucketEvents\",\"Effect\":\"Allow\",\"Principal\":{\"Service\":\"s3.amazonaws.com\"},\"Action\":\"sqs:SendMessage\",\"Resource\":\"${queue_arn}\",\"Condition\":{\"ArnEquals\":{\"aws:SourceArn\":\"arn:aws:s3:::${bucket}\"},\"StringEquals\":{\"aws:SourceAccount\":\"${account_id}\"}}},{\"Sid\":\"AllowExactLocalSyntheticRequeue\",\"Effect\":\"Allow\",\"Principal\":{\"AWS\":\"arn:aws:iam::${account_id}:root\"},\"Action\":\"sqs:SendMessage\",\"Resource\":\"${queue_arn}\"}]}"}
EOF

awslocal sqs set-queue-attributes \
  --queue-url "${queue_url}" \
  --attributes "file://${queue_policy_attributes_file}" >/dev/null

notification_configuration_file="$(mktemp)"
cat >"${notification_configuration_file}" <<EOF
{"QueueConfigurations":[{"Id":"document-object-created-put","QueueArn":"${queue_arn}","Events":["s3:ObjectCreated:Put"],"Filter":{"Key":{"FilterRules":[{"Name":"prefix","Value":"documents/"}]}}}]}
EOF

awslocal s3api put-bucket-notification-configuration \
  --bucket "${bucket}" \
  --notification-configuration "file://${notification_configuration_file}" >/dev/null
