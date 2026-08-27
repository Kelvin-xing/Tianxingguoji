import {
  DeleteMessageCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SQSClient,
  type Message,
} from "@aws-sdk/client-sqs";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import {
  DOCUMENT_SCAN_POLICY_VERSION,
  isOpaqueDocumentObjectKey,
} from "../modules/documents/public.ts";
import {
  DocumentScanDeadLetterWorkerError,
  DocumentScanRetryableWorkerError,
  processDocumentCleanupFromDeadLetter,
  processDocumentObjectCreated,
} from "./scan-document.ts";

const SAFE_MESSAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROVIDER_VERSION = /^\S{1,1024}$/;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const QUEUE_NAME = /^[A-Za-z0-9_-]{1,80}$/;
const LOCAL_QUEUE_REGION = "ap-east-1" as const;
const LOCAL_QUEUE_ACCOUNT_ID = "000000000000";
const LOCALSTACK_DEFAULT_QUEUE_ORIGIN = "http://localhost.localstack.cloud:4566";
const S3_TEST_EVENT_KEYS = Object.freeze([
  "Bucket",
  "Event",
  "HostId",
  "RequestId",
  "Service",
  "Time",
] as const);
const MAX_S3_TEST_EVENT_VALUE_LENGTH = 256;
const SAFE_EVIDENCE_SWITCH = "LOCAL_SYNTHETIC_DOCUMENT_WORKER_SAFE_EVIDENCE";

export const DOCUMENT_WORKER_MAIN_DELETE_REQUESTED_MARKER =
  "document-worker-main-delete-requested";
export const DOCUMENT_WORKER_MAIN_DELETE_COMPLETED_MARKER =
  "document-worker-main-delete-completed";

export class DocumentWorkerUnavailable extends Error {
  constructor() {
    super("Document worker is unavailable.");
    this.name = "DocumentWorkerUnavailable";
  }
}

export async function runDocumentWorker(
  _signal: Readonly<{ readonly stopped: () => boolean }> = processSignal(),
): Promise<void> {
  throw new DocumentWorkerUnavailable();
}

export function emitDocumentWorkerSafeEvidence(
  marker: unknown,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  write: (value: string) => unknown = (value) => process.stdout.write(value),
): void {
  if (environment.APP_RUNTIME_MODE !== "local-synthetic" ||
      environment[SAFE_EVIDENCE_SWITCH] !== "1" ||
      (marker !== DOCUMENT_WORKER_MAIN_DELETE_REQUESTED_MARKER &&
        marker !== DOCUMENT_WORKER_MAIN_DELETE_COMPLETED_MARKER)) {
    return;
  }
  write(`${marker}\n`);
}

async function resolveQueueUrl(
  client: SQSClient,
  endpoint: string,
  region: typeof LOCAL_QUEUE_REGION,
  queue: string,
  timeoutMs: number,
): Promise<string> {
  const result = await runBounded(
    (abortSignal) => client.send(
      new GetQueueUrlCommand({ QueueName: queue }),
      { abortSignal },
    ),
    timeoutMs,
  );
  return validateLocalQueueUrl(result.QueueUrl, endpoint, region, queue);
}

async function deleteMessage(
  client: SQSClient,
  queueUrl: string,
  message: Message,
  timeoutMs: number,
): Promise<void> {
  if (typeof message.ReceiptHandle !== "string" || message.ReceiptHandle === "") unavailable();
  await runBounded(
    (abortSignal) => client.send(new DeleteMessageCommand({
      QueueUrl: queueUrl,
      ReceiptHandle: message.ReceiptHandle,
    }), { abortSignal }),
    timeoutMs,
  );
}

export function validateLocalQueueUrl(
  value: unknown,
  expectedEndpoint: string,
  expectedRegion: typeof LOCAL_QUEUE_REGION,
  expectedQueue: string,
): string {
  if (typeof value !== "string" || value.trim() === "" ||
      expectedRegion !== LOCAL_QUEUE_REGION || !QUEUE_NAME.test(expectedQueue)) unavailable();
  let queueUrl: URL;
  let endpoint: URL;
  try {
    queueUrl = new URL(value);
    endpoint = new URL(expectedEndpoint);
  } catch {
    unavailable();
  }
  const path = queueUrl.pathname.split("/");
  if (endpoint.protocol !== "http:" || !LOOPBACK.has(endpoint.hostname.toLowerCase()) ||
      endpoint.port === "" || !isValidPort(endpoint.port) ||
      endpoint.username !== "" || endpoint.password !== "" ||
      (endpoint.pathname !== "/" && endpoint.pathname !== "") ||
      endpoint.search !== "" || endpoint.hash !== "" ||
      (queueUrl.origin !== endpoint.origin && queueUrl.origin !== LOCALSTACK_DEFAULT_QUEUE_ORIGIN) ||
      queueUrl.username !== "" || queueUrl.password !== "" ||
      queueUrl.search !== "" || queueUrl.hash !== "" || path.length !== 5 || path[0] !== "" ||
      path[1] !== "queue" || path[2] !== expectedRegion || path[3] !== LOCAL_QUEUE_ACCOUNT_ID ||
      path[4] !== expectedQueue || path.some((part) => part.includes("%"))) {
    unavailable();
  }
  return new URL(queueUrl.pathname, endpoint.origin).toString();
}

function isValidPort(value: string): boolean {
  return /^\d{1,5}$/u.test(value) && Number(value) >= 1 && Number(value) <= 65_535;
}

export async function documentMessageDisposition(
  message: Message,
  expectedBucket: string,
  processEvent: typeof processDocumentObjectCreated = processDocumentObjectCreated,
): Promise<"delete" | "retain"> {
  try {
    if (isDocumentS3TestEventMessage(message, expectedBucket)) return "delete";
    const event = parseDocumentObjectCreatedMessage(message, expectedBucket);
    await processEvent(event);
    return "delete";
  } catch (error) {
    if (error instanceof DocumentScanRetryableWorkerError ||
        error instanceof DocumentScanDeadLetterWorkerError) {
      return "retain";
    }
    return "retain";
  }
}

export async function documentDeadLetterMessageDisposition(
  message: Message,
  expectedBucket: string,
  processEvent: typeof processDocumentCleanupFromDeadLetter =
    processDocumentCleanupFromDeadLetter,
): Promise<"delete" | "retain"> {
  try {
    const event = parseDocumentObjectCreatedMessage(message, expectedBucket, true);
    const result = await processEvent(event);
    return result.status === "abandoned_removed" ||
      result.status === "unbound_provider_version_removed" ? "delete" : "retain";
  } catch {
    return "retain";
  }
}

async function runBounded<Output>(
  operation: (signal: AbortSignal) => Promise<Output>,
  timeoutMs: number,
): Promise<Output> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

export function parseDocumentObjectCreatedMessage(
  message: Message,
  expectedBucket: string,
  deadLetter = false,
) {
  const parsedMessage = parseDocumentSqsMessage(message, expectedBucket, deadLetter);
  const root = parsedMessage.body;
  const records = root.Records;
  if (!Array.isArray(records) || records.length !== 1) unavailable();
  const event = record(records[0]);
  const s3 = record(event.s3);
  const bucket = record(s3.bucket);
  const object = record(s3.object);
  if (event.eventSource !== "aws:s3" || event.eventName !== "ObjectCreated:Put" ||
      event.awsRegion !== "ap-east-1" || bucket.name !== expectedBucket ||
      typeof object.key !== "string" || typeof object.versionId !== "string" ||
      !PROVIDER_VERSION.test(object.versionId)) {
    unavailable();
  }
  let key: string;
  try {
    key = decodeURIComponent(object.key.replaceAll("+", " "));
  } catch {
    unavailable();
  }
  if (!isOpaqueDocumentObjectKey(key)) unavailable();
  return Object.freeze({
    eventId: `s3-${message.MessageId}`,
    requestId: `document-worker-${message.MessageId}`,
    bucket: expectedBucket,
    key,
    versionId: object.versionId,
    scanPolicyVersion: DOCUMENT_SCAN_POLICY_VERSION,
    deliveryAttempt: Math.min(parsedMessage.deliveryAttempt, 3),
  });
}

export function isDocumentS3TestEventMessage(
  message: Message,
  expectedBucket: string,
): boolean {
  const root = parseDocumentSqsMessage(message, expectedBucket, false).body;
  if (Object.hasOwn(root, "Records")) return false;
  const keys = Object.keys(root).sort();
  if (keys.length !== S3_TEST_EVENT_KEYS.length ||
      !keys.every((key, index) => key === S3_TEST_EVENT_KEYS[index]) ||
      root.Service !== "Amazon S3" || root.Event !== "s3:TestEvent" ||
      root.Bucket !== expectedBucket || !boundedS3TestEventValue(root.Time) ||
      !boundedS3TestEventValue(root.RequestId) || !boundedS3TestEventValue(root.HostId)) {
    unavailable();
  }
  return true;
}

function parseDocumentSqsMessage(
  message: Message,
  expectedBucket: string,
  deadLetter: boolean,
): Readonly<{ body: Record<string, unknown>; deliveryAttempt: number }> {
  if (!message.Body || !message.MessageId || !SAFE_MESSAGE_ID.test(message.MessageId) ||
      !message.ReceiptHandle || expectedBucket.trim() === "") unavailable();
  const attemptRaw = message.Attributes?.ApproximateReceiveCount;
  if (!attemptRaw || !(deadLetter ? /^\d+$/u : /^[1-3]$/u).test(attemptRaw) ||
      !Number.isSafeInteger(Number(attemptRaw)) || Number(attemptRaw) < 1) {
    unavailable();
  }
  let body: unknown;
  try {
    body = JSON.parse(message.Body);
  } catch {
    unavailable();
  }
  return Object.freeze({ body: record(body), deliveryAttempt: Number(attemptRaw) });
}

function boundedS3TestEventValue(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value === value.trim() &&
    value.length <= MAX_S3_TEST_EVENT_VALUE_LENGTH && !/[\r\n]/u.test(value);
}

function processSignal(): Readonly<{ readonly stopped: () => boolean }> {
  let stopping = false;
  const stop = () => { stopping = true; };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  return Object.freeze({ stopped: () => stopping });
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) unavailable();
  return value as Record<string, unknown>;
}

function unavailable(): never {
  throw new DocumentWorkerUnavailable();
}

export function isDirectDocumentWorkerEntry(
  argvPath: string | undefined,
  moduleUrl = import.meta.url,
): boolean {
  if (!argvPath) return false;
  try {
    return realpathSync.native(resolve(argvPath)) ===
      realpathSync.native(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isDirectDocumentWorkerEntry(process.argv[1])) {
  void runDocumentWorker().catch(() => {
    process.stderr.write("document-worker-unavailable\n");
    process.exitCode = 1;
  });
}
