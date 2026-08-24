import "server-only";

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import {
  DOCUMENT_OBJECT_REGION,
  isOpaqueDocumentObjectKey,
  type DocumentUploadContentType,
} from "../domain/contract.ts";
import type { DocumentObjectHead } from "../application/object-receipt-service.ts";
import type { DocumentCapabilitySigner } from "../application/transfer-service.ts";

const BASE64_SHA256 = /^[A-Za-z0-9+/]{43}=$/;
const PROVIDER_VERSION = /^\S{1,1024}$/;

export interface DocumentObjectReader {
  headExact(input: {
    readonly bucket: string;
    readonly key: string;
    readonly providerVersionId: string;
    readonly signal?: AbortSignal;
  }): Promise<DocumentObjectHead>;
  readExact(input: {
    readonly bucket: string;
    readonly key: string;
    readonly providerVersionId: string;
    readonly signal?: AbortSignal;
  }): Promise<AsyncIterable<Uint8Array>>;
}

export interface DocumentObjectCleaner {
  deleteExact(input: {
    readonly bucket: string;
    readonly key: string;
    readonly providerVersionId: string;
    readonly signal?: AbortSignal;
  }): Promise<"deleted" | "already_absent">;
}

export class LocalDocumentObjectStoreUnavailable extends Error {
  constructor() {
    super("Local document object store is unavailable.");
    this.name = "LocalDocumentObjectStoreUnavailable";
  }
}

export class LocalSyntheticDocumentObjectStore
implements DocumentCapabilitySigner, DocumentObjectReader, DocumentObjectCleaner {
  private readonly client: S3Client;
  private readonly endpointOrigin: string;
  private readonly bucket: string;
  private readonly requestTimeoutMs: number;

  constructor(input: {
    readonly endpoint: string;
    readonly bucket: string;
    readonly requestTimeoutMs?: number;
    readonly client?: S3Client;
  }) {
    let endpoint: URL;
    try {
      endpoint = new URL(input.endpoint);
    } catch {
      throw new LocalDocumentObjectStoreUnavailable();
    }
    if (endpoint.protocol !== "http:" ||
        !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname.toLowerCase()) ||
        endpoint.username !== "" || endpoint.password !== "" || endpoint.pathname !== "/" ||
        endpoint.search !== "" || endpoint.hash !== "" || input.bucket.trim() === "" ||
        (input.requestTimeoutMs !== undefined &&
          (!Number.isSafeInteger(input.requestTimeoutMs) ||
            input.requestTimeoutMs < 250 || input.requestTimeoutMs > 10_000))) {
      throw new LocalDocumentObjectStoreUnavailable();
    }
    this.endpointOrigin = endpoint.origin;
    this.bucket = input.bucket;
    this.requestTimeoutMs = input.requestTimeoutMs ?? 2_000;
    this.client = input.client ?? new S3Client({
      region: DOCUMENT_OBJECT_REGION,
      endpoint: this.endpointOrigin,
      forcePathStyle: true,
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
    });
  }

  async deleteExact(input: {
    readonly bucket: string;
    readonly key: string;
    readonly providerVersionId: string;
    readonly signal?: AbortSignal;
  }): Promise<"deleted" | "already_absent"> {
    this.assertTarget(input.bucket, input.key);
    this.assertProviderVersion(input.providerVersionId);
    const deadline = operationDeadline(input.signal, this.requestTimeoutMs);
    try {
      try {
        const result = await this.client.send(new DeleteObjectCommand({
          Bucket: input.bucket,
          Key: input.key,
          VersionId: input.providerVersionId,
        }), { abortSignal: deadline.signal });
        if (result.VersionId === input.providerVersionId) return "deleted";
        if (result.VersionId !== undefined && result.VersionId !== "") {
          throw new LocalDocumentObjectStoreUnavailable();
        }
      } catch (error) {
        if (!isExactDeleteVersionAbsence(error, input.providerVersionId)) throw error;
      }
      if (await this.exactVersionIsAbsent(input, deadline.signal)) return "already_absent";
      throw new LocalDocumentObjectStoreUnavailable();
    } catch (error) {
      if (error instanceof LocalDocumentObjectStoreUnavailable) throw error;
      throw new LocalDocumentObjectStoreUnavailable();
    } finally {
      deadline.cleanup();
    }
  }

  async issueUploadIntent(input: Parameters<DocumentCapabilitySigner["issueUploadIntent"]>[0]) {
    this.assertTarget(input.bucket, input.key);
    if (input.expiresInSeconds !== 600 || !BASE64_SHA256.test(input.checksumSha256Base64)) {
      throw new LocalDocumentObjectStoreUnavailable();
    }
    try {
      const url = await getSignedUrl(
        this.client,
        new PutObjectCommand({
          Bucket: input.bucket,
          Key: input.key,
          ContentType: input.contentType,
          ChecksumSHA256: input.checksumSha256Base64,
        }),
        {
          expiresIn: input.expiresInSeconds,
          signableHeaders: new Set(["content-type"]),
          unhoistableHeaders: new Set(["x-amz-checksum-sha256"]),
        },
      );
      this.assertSignedOrigin(url);
      this.assertSignedUpload(url);
      return Object.freeze({ url });
    } catch {
      throw new LocalDocumentObjectStoreUnavailable();
    }
  }

  async issueDownloadIntent(input: Parameters<DocumentCapabilitySigner["issueDownloadIntent"]>[0]) {
    this.assertTarget(input.bucket, input.key);
    this.assertProviderVersion(input.providerVersionId);
    if (input.expiresInSeconds !== 300) throw new LocalDocumentObjectStoreUnavailable();
    try {
      const url = await getSignedUrl(
        this.client,
        new GetObjectCommand({
          Bucket: input.bucket,
          Key: input.key,
          VersionId: input.providerVersionId,
        }),
        { expiresIn: input.expiresInSeconds },
      );
      this.assertSignedOrigin(url);
      return Object.freeze({ url });
    } catch {
      throw new LocalDocumentObjectStoreUnavailable();
    }
  }

  async headExact(input: {
    readonly bucket: string;
    readonly key: string;
    readonly providerVersionId: string;
    readonly signal?: AbortSignal;
  }): Promise<DocumentObjectHead> {
    this.assertTarget(input.bucket, input.key);
    this.assertProviderVersion(input.providerVersionId);
    try {
      const deadline = operationDeadline(input.signal, this.requestTimeoutMs);
      let result;
      try {
        result = await this.client.send(new HeadObjectCommand({
          Bucket: input.bucket,
          Key: input.key,
          VersionId: input.providerVersionId,
          ChecksumMode: "ENABLED",
        }), { abortSignal: deadline.signal });
      } finally {
        deadline.cleanup();
      }
      if (!Number.isSafeInteger(result.ContentLength) || result.ContentLength === undefined ||
          result.ContentLength < 0 ||
          typeof result.ContentType !== "string" || typeof result.ChecksumSHA256 !== "string" ||
          !BASE64_SHA256.test(result.ChecksumSHA256) ||
          result.VersionId !== input.providerVersionId) {
        throw new LocalDocumentObjectStoreUnavailable();
      }
      return Object.freeze({
        sizeBytes: result.ContentLength,
        contentType: result.ContentType,
        checksumSha256Base64: result.ChecksumSHA256,
      });
    } catch (error) {
      if (error instanceof LocalDocumentObjectStoreUnavailable) throw error;
      throw new LocalDocumentObjectStoreUnavailable();
    }
  }

  async readExact(input: {
    readonly bucket: string;
    readonly key: string;
    readonly providerVersionId: string;
    readonly signal?: AbortSignal;
  }): Promise<AsyncIterable<Uint8Array>> {
    this.assertTarget(input.bucket, input.key);
    this.assertProviderVersion(input.providerVersionId);
    try {
      const deadline = operationDeadline(input.signal, this.requestTimeoutMs);
      let result;
      try {
        result = await this.client.send(new GetObjectCommand({
          Bucket: input.bucket,
          Key: input.key,
          VersionId: input.providerVersionId,
          ChecksumMode: "ENABLED",
        }), { abortSignal: deadline.signal });
      } catch (error) {
        deadline.cleanup();
        throw error;
      }
      if (result.VersionId !== input.providerVersionId || !result.Body ||
          typeof (result.Body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] !== "function") {
        deadline.cleanup();
        throw new LocalDocumentObjectStoreUnavailable();
      }
      const body = result.Body as AsyncIterable<Uint8Array>;
      if (input.signal) {
        deadline.cleanup();
        return body;
      }
      return boundedBody(body, deadline.cleanup);
    } catch (error) {
      if (error instanceof LocalDocumentObjectStoreUnavailable) throw error;
      throw new LocalDocumentObjectStoreUnavailable();
    }
  }

  private assertTarget(bucket: string, key: string): void {
    if (bucket !== this.bucket || !isOpaqueDocumentObjectKey(key)) {
      throw new LocalDocumentObjectStoreUnavailable();
    }
  }

  private assertProviderVersion(value: string): void {
    if (!PROVIDER_VERSION.test(value)) throw new LocalDocumentObjectStoreUnavailable();
  }

  private async exactVersionIsAbsent(
    input: Readonly<{ bucket: string; key: string; providerVersionId: string }>,
    signal: AbortSignal,
  ): Promise<boolean> {
    try {
      const result = await this.client.send(new HeadObjectCommand({
        Bucket: input.bucket,
        Key: input.key,
        VersionId: input.providerVersionId,
      }), { abortSignal: signal });
      if (result.VersionId !== input.providerVersionId) {
        throw new LocalDocumentObjectStoreUnavailable();
      }
      return false;
    } catch (error) {
      if (isExactHeadAbsence(error)) return true;
      throw error;
    }
  }

  private assertSignedOrigin(value: string): void {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new LocalDocumentObjectStoreUnavailable();
    }
    if (url.origin !== this.endpointOrigin || url.protocol !== "http:" ||
        url.username !== "" || url.password !== "" || url.hash !== "") {
      throw new LocalDocumentObjectStoreUnavailable();
    }
  }

  private assertSignedUpload(value: string): void {
    const url = new URL(value);
    const signedHeaders = url.searchParams.get("X-Amz-SignedHeaders")?.split(";").sort() ?? [];
    if (signedHeaders.length !== 3 ||
        signedHeaders[0] !== "content-type" ||
        signedHeaders[1] !== "host" ||
        signedHeaders[2] !== "x-amz-checksum-sha256" ||
        url.searchParams.has("x-amz-checksum-sha256") ||
        url.searchParams.has("X-Amz-Checksum-Sha256")) {
      throw new LocalDocumentObjectStoreUnavailable();
    }
  }
}

function isExactDeleteVersionAbsence(error: unknown, providerVersionId: string): boolean {
  if (isExactS3Error(error, ["NoSuchVersion"], 404)) return true;
  if (!isExactS3Error(error, ["InvalidArgument"], 400)) return false;
  const candidate = error as Error & {
    readonly ArgumentName?: unknown;
    readonly ArgumentValue?: unknown;
  };
  return Object.hasOwn(candidate, "ArgumentName") &&
    Object.hasOwn(candidate, "ArgumentValue") &&
    candidate.ArgumentName === "versionId" &&
    candidate.ArgumentValue === providerVersionId;
}

function isExactHeadAbsence(error: unknown): boolean {
  return isExactS3Error(error, ["NoSuchKey", "NoSuchVersion", "NotFound"], 404);
}

function isExactS3Error(error: unknown, names: readonly string[], status: number): boolean {
  if (!(error instanceof Error) || !names.includes(error.name)) return false;
  const metadata = (error as Error & { readonly $metadata?: unknown }).$metadata;
  return typeof metadata === "object" && metadata !== null &&
    !Array.isArray(metadata) &&
    (metadata as { readonly httpStatusCode?: unknown }).httpStatusCode === status;
}

function operationDeadline(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Readonly<{ readonly signal: AbortSignal; readonly cleanup: () => void }> {
  if (signal) return Object.freeze({ signal, cleanup: () => undefined });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return Object.freeze({
    signal: controller.signal,
    cleanup: () => clearTimeout(timeout),
  });
}

async function* boundedBody(
  body: AsyncIterable<Uint8Array>,
  cleanup: () => void,
): AsyncIterable<Uint8Array> {
  try {
    yield* body;
  } finally {
    cleanup();
  }
}

export function isDocumentContentType(value: unknown): value is DocumentUploadContentType {
  return value === "application/pdf" || value === "image/jpeg" || value === "image/png";
}
