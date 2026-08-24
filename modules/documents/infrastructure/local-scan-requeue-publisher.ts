import "server-only";

import {
  GetQueueUrlCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";

import type {
  DocumentScanReconciliationCandidate,
  DocumentScanRequeuePublisher,
} from "../application/scan-service.ts";
import { isOpaqueDocumentObjectKey } from "../domain/contract.ts";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const QUEUE = /^[A-Za-z0-9_-]{1,80}$/;
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const PROVIDER_VERSION = /^\S{1,1024}$/;
const LOCAL_QUEUE_ACCOUNT_ID = "000000000000";
const LOCALSTACK_DEFAULT_QUEUE_ORIGIN = "http://localhost.localstack.cloud:4566";

export class DocumentScanRequeueUnavailable extends Error {
  constructor() {
    super("Document scan requeue is unavailable.");
    this.name = "DocumentScanRequeueUnavailable";
  }
}

export class LocalSyntheticDocumentScanRequeuePublisher
implements DocumentScanRequeuePublisher {
  private readonly client: SQSClient;
  private readonly queue: string;
  private readonly bucket: string;
  private readonly region: "ap-east-1";
  private readonly endpointOrigin: string;
  private readonly requestTimeoutMs: number;
  private queueUrl: Promise<string> | null = null;

  constructor(input: {
    readonly endpoint: string;
    readonly region: "ap-east-1";
    readonly queue: string;
    readonly bucket: string;
    readonly requestTimeoutMs: number;
  }) {
    let endpoint: URL;
    try {
      endpoint = new URL(input.endpoint);
    } catch {
      throw new DocumentScanRequeueUnavailable();
    }
    if (endpoint.protocol !== "http:" || !LOOPBACK.has(endpoint.hostname.toLowerCase()) ||
        endpoint.port === "" || !isValidPort(endpoint.port) ||
        endpoint.username !== "" || endpoint.password !== "" ||
        (endpoint.pathname !== "/" && endpoint.pathname !== "") ||
        endpoint.search !== "" || endpoint.hash !== "" ||
        !QUEUE.test(input.queue) || !BUCKET.test(input.bucket) ||
        !Number.isSafeInteger(input.requestTimeoutMs) || input.requestTimeoutMs < 250 ||
        input.requestTimeoutMs > 10_000) {
      throw new DocumentScanRequeueUnavailable();
    }
    this.queue = input.queue;
    this.bucket = input.bucket;
    this.region = input.region;
    this.endpointOrigin = endpoint.origin;
    this.requestTimeoutMs = input.requestTimeoutMs;
    this.client = new SQSClient({
      region: input.region,
      endpoint: endpoint.origin,
      useQueueUrlAsEndpoint: false,
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
    });
  }

  async publish(candidate: DocumentScanReconciliationCandidate): Promise<void> {
    if (candidate.kind !== "missed_event" || candidate.bucket !== this.bucket ||
        !isOpaqueDocumentObjectKey(candidate.key) ||
        !PROVIDER_VERSION.test(candidate.versionId)) {
      throw new DocumentScanRequeueUnavailable();
    }
    try {
      const queueUrl = await this.resolveQueueUrl();
      await bounded(
        (signal) => this.client.send(new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: objectCreatedBody(candidate),
        }), { abortSignal: signal }),
        this.requestTimeoutMs,
      );
    } catch {
      throw new DocumentScanRequeueUnavailable();
    }
  }

  private resolveQueueUrl(): Promise<string> {
    this.queueUrl ??= bounded(
      (signal) => this.client.send(
        new GetQueueUrlCommand({ QueueName: this.queue }),
        { abortSignal: signal },
      ),
      this.requestTimeoutMs,
    ).then((result) => {
      return validateLocalScanRequeueQueueUrl(
        result.QueueUrl,
        this.endpointOrigin,
        this.region,
        this.queue,
      );
    });
    return this.queueUrl;
  }
}

export function validateLocalScanRequeueQueueUrl(
  value: unknown,
  expectedEndpoint: string,
  expectedRegion: "ap-east-1",
  expectedQueue: string,
): string {
  if (typeof value !== "string" || value.trim() === "" ||
      expectedRegion !== "ap-east-1" || !QUEUE.test(expectedQueue)) {
    throw new DocumentScanRequeueUnavailable();
  }
  let queueUrl: URL;
  let endpoint: URL;
  try {
    queueUrl = new URL(value);
    endpoint = new URL(expectedEndpoint);
  } catch {
    throw new DocumentScanRequeueUnavailable();
  }
  const path = queueUrl.pathname.split("/");
  if (endpoint.protocol !== "http:" || !LOOPBACK.has(endpoint.hostname.toLowerCase()) ||
      endpoint.port === "" || !isValidPort(endpoint.port) ||
      endpoint.username !== "" || endpoint.password !== "" ||
      (endpoint.pathname !== "/" && endpoint.pathname !== "") ||
      endpoint.search !== "" || endpoint.hash !== "" ||
      (queueUrl.origin !== endpoint.origin && queueUrl.origin !== LOCALSTACK_DEFAULT_QUEUE_ORIGIN) ||
      queueUrl.username !== "" ||
      queueUrl.password !== "" || queueUrl.search !== "" || queueUrl.hash !== "" ||
      path.length !== 5 || path[0] !== "" || path[1] !== "queue" ||
      path[2] !== expectedRegion || path[3] !== LOCAL_QUEUE_ACCOUNT_ID ||
      path[4] !== expectedQueue || path.some((part) => part.includes("%"))) {
    throw new DocumentScanRequeueUnavailable();
  }
  return new URL(queueUrl.pathname, endpoint.origin).toString();
}

function isValidPort(value: string): boolean {
  return /^\d{1,5}$/u.test(value) && Number(value) >= 1 && Number(value) <= 65_535;
}

function objectCreatedBody(candidate: DocumentScanReconciliationCandidate): string {
  return JSON.stringify({
    Records: [{
      eventSource: "aws:s3",
      eventName: "ObjectCreated:Put",
      awsRegion: "ap-east-1",
      s3: {
        bucket: { name: candidate.bucket },
        object: { key: candidate.key, versionId: candidate.versionId },
      },
    }],
  });
}

async function bounded<Output>(
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
