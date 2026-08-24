import assert from "node:assert/strict";
import test from "node:test";

import {
  DocumentScanRequeueUnavailable,
  validateLocalScanRequeueQueueUrl,
} from "../../../modules/documents/infrastructure/local-scan-requeue-publisher.ts";

const ENDPOINT = "http://127.0.0.1:4566";
const QUEUE = "tianxing-document-scan";
const VALID = `${ENDPOINT}/queue/ap-east-1/000000000000/${QUEUE}`;

test("requeue publisher accepts only the frozen LocalStack path QueueUrl", () => {
  assert.equal(
    validateLocalScanRequeueQueueUrl(VALID, ENDPOINT, "ap-east-1", QUEUE),
    VALID,
  );
  assert.equal(
    validateLocalScanRequeueQueueUrl(
      `http://localhost.localstack.cloud:4566/queue/ap-east-1/000000000000/${QUEUE}`,
      ENDPOINT,
      "ap-east-1",
      QUEUE,
    ),
    VALID,
  );

  for (const value of [
    `${ENDPOINT}/000000000000/${QUEUE}`,
    `http://localhost:4566/queue/ap-east-1/000000000000/${QUEUE}`,
    `http://localhost.localstack.cloud:4567/queue/ap-east-1/000000000000/${QUEUE}`,
    `https://localhost.localstack.cloud:4566/queue/ap-east-1/000000000000/${QUEUE}`,
    `${ENDPOINT}/queue/us-east-1/000000000000/${QUEUE}`,
    `${ENDPOINT}/queue/ap-east-1/00000000000/${QUEUE}`,
    `${ENDPOINT}/queue/ap-east-1/111111111111/${QUEUE}`,
    `${ENDPOINT}/queue/ap-east-1/000000000000/other`,
    `${ENDPOINT}/queue/ap-east-1/000000000000/${QUEUE}/extra`,
    `${ENDPOINT}/queue/ap-east-1/000000000000/%74ianxing-document-scan`,
    `${ENDPOINT}/queue/ap-east-1/000000000000/${QUEUE}?token=private`,
    `http://outside.invalid/queue/ap-east-1/000000000000/${QUEUE}`,
  ]) {
    assert.throws(
      () => validateLocalScanRequeueQueueUrl(value, ENDPOINT, "ap-east-1", QUEUE),
      DocumentScanRequeueUnavailable,
    );
  }

  assert.throws(
    () => validateLocalScanRequeueQueueUrl(VALID, ENDPOINT, "ap-east-1", "*"),
    DocumentScanRequeueUnavailable,
  );

  for (const endpoint of [
    "http://127.0.0.1",
    "https://127.0.0.1:4566",
    "http://outside.invalid:4566",
    "http://user:secret@127.0.0.1:4566",
    "http://127.0.0.1:4566/path",
    "http://127.0.0.1:4566?private=1",
  ]) {
    assert.throws(
      () => validateLocalScanRequeueQueueUrl(VALID, endpoint, "ap-east-1", QUEUE),
      DocumentScanRequeueUnavailable,
    );
  }
});
