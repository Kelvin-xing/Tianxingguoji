import "server-only";

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";

import {
  DocumentTransportConfigurationError,
  loadDocumentTransportConfig,
  type DocumentTransportConfig,
} from "../../../lib/runtime/document-transport-config.ts";
import type { DocumentCapabilitySigner } from "../application/transfer-service.ts";
import {
  DOCUMENT_UPLOAD_CONTENT_TYPES,
  DOCUMENT_UPLOAD_MAX_BYTES,
  isOpaqueDocumentObjectKey,
} from "../domain/contract.ts";
import type { DocumentObjectCleaner, DocumentObjectReader } from "./object-transport-port.ts";

const MIN_UPLOAD_BYTES = 1_048_576;
const BASE64_SHA256 = /^[A-Za-z0-9+/]{43}=$/;
const TOKEN = /^[A-Za-z0-9_-]{80,4096}$/;
const PROVIDER_VERSION = /^fake-v1-[0-9a-f]{64}$/;
const TRANSPORT_PATH = "/api/v1/documents/deterministic-transport/";

interface Capability {
  readonly version: 1;
  readonly operation: "upload" | "download";
  readonly bucket: string;
  readonly key: string;
  readonly providerVersionId?: string;
  readonly contentType?: string;
  readonly checksumSha256Base64?: string;
  readonly expiresAtMs: number;
}

interface StoredObject {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly checksumSha256Base64: string;
}

export class DeterministicDocumentTransportUnavailable extends Error {
  constructor() {
    super("Deterministic document transport is unavailable.");
    this.name = "DeterministicDocumentTransportUnavailable";
  }
}

/** Explicit non-production transport preserving versioned object semantics in process memory. */
export class DeterministicFakeDocumentTransport
implements DocumentCapabilitySigner, DocumentObjectReader, DocumentObjectCleaner {
  private readonly config: Extract<DocumentTransportConfig, { mode: "deterministic-fake" }>;
  private readonly now: () => number;
  private readonly objects = new Map<string, StoredObject>();

  constructor(input: {
    readonly config: Extract<DocumentTransportConfig, { mode: "deterministic-fake" }>;
    readonly now?: () => number;
  }) {
    this.config = input.config;
    this.now = input.now ?? Date.now;
  }

  async issueUploadIntent(input: Parameters<DocumentCapabilitySigner["issueUploadIntent"]>[0]) {
    this.assertTarget(input.bucket, input.key);
    if (input.expiresInSeconds !== 600 ||
        !(DOCUMENT_UPLOAD_CONTENT_TYPES as readonly string[]).includes(input.contentType) ||
        !BASE64_SHA256.test(input.checksumSha256Base64)) unavailable();
    return Object.freeze({
      url: this.capabilityUrl({
        version: 1,
        operation: "upload",
        bucket: input.bucket,
        key: input.key,
        contentType: input.contentType,
        checksumSha256Base64: input.checksumSha256Base64,
        expiresAtMs: this.expiry(input.expiresInSeconds),
      }),
    });
  }

  async issueDownloadIntent(input: Parameters<DocumentCapabilitySigner["issueDownloadIntent"]>[0]) {
    this.assertTarget(input.bucket, input.key);
    if (input.expiresInSeconds !== 300 || !PROVIDER_VERSION.test(input.providerVersionId)) {
      unavailable();
    }
    return Object.freeze({
      url: this.capabilityUrl({
        version: 1,
        operation: "download",
        bucket: input.bucket,
        key: input.key,
        providerVersionId: input.providerVersionId,
        expiresAtMs: this.expiry(input.expiresInSeconds),
      }),
    });
  }

  async put(token: string, request: Request): Promise<{
    readonly providerVersionId: string;
    readonly bucket: string;
    readonly key: string;
  }> {
    const capability = this.openCapability(token, "upload");
    const contentType = request.headers.get("content-type");
    const checksum = request.headers.get("x-amz-checksum-sha256");
    if (contentType !== capability.contentType || checksum !== capability.checksumSha256Base64) {
      unavailable();
    }
    const bytes = await readBoundedBody(request);
    const actualChecksum = createHash("sha256").update(bytes).digest("base64");
    if (actualChecksum !== checksum) unavailable();
    const providerVersionId = `fake-v1-${createHash("sha256")
      .update(capability.bucket).update("\0").update(capability.key).update("\0").update(bytes)
      .digest("hex")}`;
    this.objects.set(objectId(capability.bucket, capability.key, providerVersionId), {
      bytes: Uint8Array.from(bytes),
      contentType,
      checksumSha256Base64: actualChecksum,
    });
    return Object.freeze({
      providerVersionId,
      bucket: capability.bucket,
      key: capability.key,
    });
  }

  async get(token: string): Promise<StoredObject> {
    const capability = this.openCapability(token, "download");
    const object = this.objects.get(objectId(
      capability.bucket,
      capability.key,
      capability.providerVersionId ?? "",
    ));
    if (!object) unavailable();
    return object;
  }

  async headExact(input: Parameters<DocumentObjectReader["headExact"]>[0]) {
    const object = this.exact(input.bucket, input.key, input.providerVersionId);
    return Object.freeze({
      sizeBytes: object.bytes.byteLength,
      contentType: object.contentType,
      checksumSha256Base64: object.checksumSha256Base64,
    });
  }

  async readExact(input: Parameters<DocumentObjectReader["readExact"]>[0]) {
    const object = this.exact(input.bucket, input.key, input.providerVersionId);
    return (async function* () { yield Uint8Array.from(object.bytes); })();
  }

  async deleteExact(input: Parameters<DocumentObjectCleaner["deleteExact"]>[0]) {
    this.assertTarget(input.bucket, input.key);
    if (!PROVIDER_VERSION.test(input.providerVersionId)) unavailable();
    return this.objects.delete(objectId(input.bucket, input.key, input.providerVersionId))
      ? "deleted" as const
      : "already_absent" as const;
  }

  private exact(bucket: string, key: string, providerVersionId: string): StoredObject {
    this.assertTarget(bucket, key);
    if (!PROVIDER_VERSION.test(providerVersionId)) unavailable();
    const object = this.objects.get(objectId(bucket, key, providerVersionId));
    if (!object) unavailable();
    return object;
  }

  private capabilityUrl(capability: Capability): string {
    const plaintext = Buffer.from(JSON.stringify(capability), "utf8");
    const key = createHash("sha256").update(this.config.signingSecret).digest();
    const iv = createHmac("sha256", key).update(plaintext).digest().subarray(0, 12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return `${this.config.origin}${TRANSPORT_PATH}${Buffer.concat([
      iv,
      cipher.getAuthTag(),
      ciphertext,
    ]).toString("base64url")}`;
  }

  private openCapability(token: string, operation: Capability["operation"]): Capability {
    if (!TOKEN.test(token)) unavailable();
    let packed: Buffer;
    try {
      packed = Buffer.from(token, "base64url");
    } catch {
      unavailable();
    }
    if (packed.byteLength < 29) unavailable();
    const key = createHash("sha256").update(this.config.signingSecret).digest();
    const iv = packed.subarray(0, 12);
    const tag = packed.subarray(12, 28);
    let plaintext: Buffer;
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      plaintext = Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]);
    } catch {
      unavailable();
    }
    let candidate: unknown;
    try {
      candidate = JSON.parse(plaintext.toString("utf8"));
    } catch {
      unavailable();
    }
    const capability = validateCapability(candidate, this.config, operation, this.now());
    const expectedIv = createHmac("sha256", key).update(plaintext).digest().subarray(0, 12);
    if (!timingSafeEqual(iv, expectedIv)) unavailable();
    return capability;
  }

  private assertTarget(bucket: string, key: string): void {
    if (bucket !== this.config.bucket || !isOpaqueDocumentObjectKey(key)) unavailable();
  }

  private expiry(seconds: number): number {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now <= 0) unavailable();
    return now + seconds * 1000;
  }
}

const globalForFakeTransport = globalThis as typeof globalThis & {
  __txDeterministicDocumentTransport?: Readonly<{
    signature: string;
    transport: DeterministicFakeDocumentTransport;
  }>;
};

export function getDeterministicFakeDocumentTransport(): DeterministicFakeDocumentTransport {
  const config = loadDocumentTransportConfig();
  if (config.mode !== "deterministic-fake") unavailable();
  const signature = `${config.origin}\0${config.bucket}\0${config.signingSecret}`;
  if (globalForFakeTransport.__txDeterministicDocumentTransport?.signature === signature) {
    return globalForFakeTransport.__txDeterministicDocumentTransport.transport;
  }
  const transport = new DeterministicFakeDocumentTransport({ config });
  globalForFakeTransport.__txDeterministicDocumentTransport = Object.freeze({ signature, transport });
  return transport;
}

export async function handleDeterministicDocumentTransportRequest(
  request: Request,
  token: string,
): Promise<Response> {
  try {
    const transport = getDeterministicFakeDocumentTransport();
    if (request.method === "PUT") {
      const uploaded = await transport.put(token, request);
      // The fake transport emulates the production object-created event boundary.
      // A failure remains observable through the document state and does not undo PUT.
      try {
        const { deterministicFakeScanEvent, getDocumentScanRuntime } = await import("./scan-runtime.ts");
        await getDocumentScanRuntime().queue.publish(deterministicFakeScanEvent({
          bucket: uploaded.bucket,
          key: uploaded.key,
          providerVersionId: uploaded.providerVersionId,
          eventId: `fake-object-${uploaded.providerVersionId}`,
          requestId: `fake-scan-${uploaded.providerVersionId}`,
        }));
      } catch {
        // Upload success is independent from asynchronous scan delivery.
      }
      return new Response(null, {
        status: 200,
        headers: { "cache-control": "no-store", "x-amz-version-id": uploaded.providerVersionId },
      });
    }
    if (request.method === "GET") {
      const object = await transport.get(token);
      return new Response(Uint8Array.from(object.bytes), {
        status: 200,
        headers: {
          "cache-control": "no-store",
          "content-type": object.contentType,
          "content-length": String(object.bytes.byteLength),
        },
      });
    }
    return new Response(null, { status: 405, headers: { allow: "GET, PUT" } });
  } catch (error) {
    const unavailableConfiguration = error instanceof DocumentTransportConfigurationError;
    return new Response(null, {
      status: unavailableConfiguration ? 503 : 404,
      headers: { "cache-control": "no-store" },
    });
  }
}

function validateCapability(
  value: unknown,
  config: Extract<DocumentTransportConfig, { mode: "deterministic-fake" }>,
  operation: Capability["operation"],
  now: number,
): Capability {
  if (typeof value !== "object" || value === null || Array.isArray(value)) unavailable();
  const capability = value as Partial<Capability>;
  if (capability.version !== 1 || capability.operation !== operation ||
      capability.bucket !== config.bucket || typeof capability.key !== "string" ||
      !isOpaqueDocumentObjectKey(capability.key) || !Number.isSafeInteger(capability.expiresAtMs) ||
      (capability.expiresAtMs ?? 0) <= now) unavailable();
  if (operation === "upload" &&
      (!(DOCUMENT_UPLOAD_CONTENT_TYPES as readonly unknown[]).includes(capability.contentType) ||
        typeof capability.checksumSha256Base64 !== "string" ||
        !BASE64_SHA256.test(capability.checksumSha256Base64) ||
        capability.providerVersionId !== undefined)) unavailable();
  if (operation === "download" &&
      (typeof capability.providerVersionId !== "string" ||
        !PROVIDER_VERSION.test(capability.providerVersionId) || capability.contentType !== undefined ||
        capability.checksumSha256Base64 !== undefined)) unavailable();
  return capability as Capability;
}

async function readBoundedBody(request: Request): Promise<Uint8Array> {
  if (!request.body) unavailable();
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) < MIN_UPLOAD_BYTES ||
      Number(declared) > DOCUMENT_UPLOAD_MAX_BYTES)) unavailable();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > DOCUMENT_UPLOAD_MAX_BYTES) {
      await reader.cancel();
      unavailable();
    }
    chunks.push(next.value);
  }
  if (size < MIN_UPLOAD_BYTES) unavailable();
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function objectId(bucket: string, key: string, providerVersionId: string): string {
  return `${bucket}\0${key}\0${providerVersionId}`;
}

function unavailable(): never {
  throw new DeterministicDocumentTransportUnavailable();
}
