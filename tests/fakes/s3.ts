import { DOCUMENT_OBJECT_REGION, type DocumentObjectRegion } from "../../modules/documents/contract.ts";

export type SyntheticS3Operation =
  | "put_object"
  | "head_object"
  | "record_event"
  | "delete_object";
export type SyntheticS3Outcome =
  | "success"
  | "timeout"
  | "access_denied"
  | "not_found"
  | "event_lost";
export type SyntheticS3ErrorCode =
  | "S3_TIMEOUT"
  | "S3_ACCESS_DENIED"
  | "S3_NOT_FOUND"
  | "S3_EVENT_LOST";

export interface SyntheticS3ObjectMetadata {
  readonly region: DocumentObjectRegion;
  readonly bucket: string;
  readonly key: string;
  readonly versionId: string | null;
  readonly checksumSha256: string;
  readonly sizeBytes: number;
}

export interface SyntheticS3ObjectInput {
  readonly region: DocumentObjectRegion;
  readonly bucket: string;
  readonly key: string;
  readonly versionId: string | null;
  readonly checksumSha256: string;
  readonly sizeBytes: number;
}

export interface SyntheticS3EventInput {
  readonly eventId: string;
  readonly key: string;
  readonly versionId: string | null;
}

export type SyntheticS3EventResult =
  | { readonly status: "accepted"; readonly eventId: string }
  | { readonly status: "duplicate"; readonly eventId: string };

export interface SyntheticS3Call {
  readonly operation: SyntheticS3Operation;
  readonly key: string;
  readonly versionId: string | null;
}

export class SyntheticS3Error extends Error {
  readonly code: SyntheticS3ErrorCode;
  readonly retryable: boolean;

  constructor(code: SyntheticS3ErrorCode) {
    super(code);
    this.name = "SyntheticS3Error";
    this.code = code;
    this.retryable = code === "S3_TIMEOUT" || code === "S3_EVENT_LOST";
  }
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_BUCKET_PATTERN = /^[a-z0-9][a-z0-9.-]{1,62}[a-z0-9]$/;
const SAFE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9/_.:-]{0,255}$/;
const SAFE_EVENT_ID_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/;

export class SyntheticS3Fake {
  private readonly region: DocumentObjectRegion;
  private readonly bucket: string;
  private readonly objects = new Map<string, SyntheticS3ObjectMetadata>();
  private readonly seenEventIds = new Set<string>();
  private readonly outcomeQueues: Record<SyntheticS3Operation, SyntheticS3Outcome[]> = {
    put_object: [],
    head_object: [],
    record_event: [],
    delete_object: [],
  };
  private readonly recordedCalls: SyntheticS3Call[] = [];

  constructor(
    region: DocumentObjectRegion = DOCUMENT_OBJECT_REGION,
    bucket = "synthetic-release1-documents",
  ) {
    assertRegion(region);
    assertBucket(bucket);
    this.region = region;
    this.bucket = bucket;
  }

  enqueue(operation: SyntheticS3Operation, ...outcomes: SyntheticS3Outcome[]): void {
    this.outcomeQueues[operation].push(...outcomes);
  }

  async putObject(input: SyntheticS3ObjectInput): Promise<SyntheticS3ObjectMetadata> {
    this.recordCall("put_object", input.key, input.versionId);
    this.throwForOutcome("put_object");
    this.assertConfiguredObject(input);
    const metadata = Object.freeze({ ...input });
    this.objects.set(objectId(input.key, input.versionId), metadata);
    return metadata;
  }

  async headObject(input: {
    readonly key: string;
    readonly versionId: string | null;
  }): Promise<SyntheticS3ObjectMetadata> {
    this.recordCall("head_object", input.key, input.versionId);
    this.throwForOutcome("head_object");
    const metadata = this.objects.get(objectId(input.key, input.versionId));
    if (metadata === undefined) throw new SyntheticS3Error("S3_NOT_FOUND");
    return metadata;
  }

  async recordObjectEvent(input: SyntheticS3EventInput): Promise<SyntheticS3EventResult> {
    this.recordCall("record_event", input.key, input.versionId);
    assertSafeEventId(input.eventId);
    assertSafeKey(input.key);
    this.throwForOutcome("record_event");
    if (this.seenEventIds.has(input.eventId)) {
      return { status: "duplicate", eventId: input.eventId };
    }
    this.seenEventIds.add(input.eventId);
    return { status: "accepted", eventId: input.eventId };
  }

  async deleteObject(input: {
    readonly key: string;
    readonly versionId: string | null;
  }): Promise<{ readonly status: "deleted"; readonly key: string }> {
    this.recordCall("delete_object", input.key, input.versionId);
    this.throwForOutcome("delete_object");
    const deleted = this.objects.delete(objectId(input.key, input.versionId));
    if (!deleted) throw new SyntheticS3Error("S3_NOT_FOUND");
    return { status: "deleted", key: input.key };
  }

  calls(): readonly SyntheticS3Call[] {
    return this.recordedCalls.slice();
  }

  objectCount(): number {
    return this.objects.size;
  }

  private assertConfiguredObject(input: SyntheticS3ObjectInput): void {
    if (input.region !== this.region) throw new SyntheticS3Error("S3_ACCESS_DENIED");
    if (input.bucket !== this.bucket) throw new SyntheticS3Error("S3_ACCESS_DENIED");
    assertRegion(input.region);
    assertBucket(input.bucket);
    assertSafeKey(input.key);
    if (input.versionId !== null) assertSafeKey(input.versionId);
    if (!SHA256_PATTERN.test(input.checksumSha256)) {
      throw new Error("Synthetic S3 checksum must be a lowercase SHA-256 value.");
    }
    if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0) {
      throw new Error("Synthetic S3 object size must be a non-negative safe integer.");
    }
  }

  private recordCall(
    operation: SyntheticS3Operation,
    key: string,
    versionId: string | null,
  ): void {
    this.recordedCalls.push({ operation, key, versionId });
  }

  private throwForOutcome(operation: SyntheticS3Operation): void {
    const outcome = this.outcomeQueues[operation].shift() ?? "success";
    if (outcome === "success") return;
    if (outcome === "timeout") throw new SyntheticS3Error("S3_TIMEOUT");
    if (outcome === "access_denied") throw new SyntheticS3Error("S3_ACCESS_DENIED");
    if (outcome === "not_found") throw new SyntheticS3Error("S3_NOT_FOUND");
    throw new SyntheticS3Error("S3_EVENT_LOST");
  }
}

function objectId(key: string, versionId: string | null): string {
  return `${key}:${versionId ?? "null"}`;
}

function assertRegion(value: string): asserts value is DocumentObjectRegion {
  if (value !== DOCUMENT_OBJECT_REGION) {
    throw new Error("Synthetic S3 region must be ap-east-1.");
  }
}

function assertBucket(value: string): void {
  if (!SAFE_BUCKET_PATTERN.test(value)) throw new Error("Synthetic S3 bucket is unsafe.");
}

function assertSafeKey(value: string): void {
  if (!SAFE_KEY_PATTERN.test(value) || value.includes("..")) {
    throw new Error("Synthetic S3 key is unsafe.");
  }
}

function assertSafeEventId(value: string): void {
  if (!SAFE_EVENT_ID_PATTERN.test(value)) throw new Error("Synthetic S3 event ID is unsafe.");
}
