import "server-only";

import { createConnection, type Socket } from "node:net";

import {
  DOCUMENT_SCAN_TIMEOUT_MS,
} from "../domain/contract.ts";
import type { DocumentScanner } from "./scan-runtime.ts";
import type { DocumentObjectReader } from "./object-transport-port.ts";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const MAX_RESPONSE_BYTES = 4_096;

export class DocumentScannerUnavailable extends Error {
  constructor() {
    super("Document scanner is unavailable.");
    this.name = "DocumentScannerUnavailable";
  }
}

export class LocalClamavDocumentScanner implements DocumentScanner {
  private readonly reader: DocumentObjectReader;
  private readonly bucket: string;
  private readonly host: string;
  private readonly port: number;
  private readonly timeoutMs: number;
  private readonly socketFactory: (host: string, port: number) => Socket;

  constructor(input: {
    readonly reader: DocumentObjectReader;
    readonly bucket: string;
    readonly host: string;
    readonly port: number;
    readonly timeoutMs?: number;
    readonly socketFactory?: (host: string, port: number) => Socket;
  }) {
    if (!LOOPBACK.has(input.host.toLowerCase()) ||
        !Number.isSafeInteger(input.port) || input.port < 1 || input.port > 65_535 ||
        input.bucket.trim() === "" ||
        (input.timeoutMs !== undefined &&
          (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 ||
            input.timeoutMs > DOCUMENT_SCAN_TIMEOUT_MS))) {
      throw new DocumentScannerUnavailable();
    }
    this.reader = input.reader;
    this.bucket = input.bucket;
    this.host = input.host;
    this.port = input.port;
    this.timeoutMs = input.timeoutMs ?? DOCUMENT_SCAN_TIMEOUT_MS;
    this.socketFactory = input.socketFactory ?? ((host, port) => createConnection({ host, port }));
  }

  async scan(input: Parameters<DocumentScanner["scan"]>[0]) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const target = Object.freeze({
        bucket: this.bucket,
        key: input.objectKey,
        providerVersionId: input.objectVersionId,
        signal: controller.signal,
      });
      const head = await this.reader.headExact(target);
      const body = await this.reader.readExact(target);
      const result = await scanStream({
        body,
        contentType: head.contentType,
        expectedSize: head.sizeBytes,
        host: this.host,
        port: this.port,
        signal: controller.signal,
        socketFactory: this.socketFactory,
      });
      return Object.freeze({
        requestId: input.requestId,
        objectKey: input.objectKey,
        objectVersionId: input.objectVersionId,
        verdict: result,
        scannerVersion: "clamav-release1" as const,
      });
    } catch (error) {
      if (error instanceof DocumentScannerUnavailable) throw error;
      throw new DocumentScannerUnavailable();
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function scanStream(input: {
  readonly body: AsyncIterable<Uint8Array>;
  readonly contentType: string;
  readonly expectedSize: number;
  readonly host: string;
  readonly port: number;
  readonly signal: AbortSignal;
  readonly socketFactory: (host: string, port: number) => Socket;
}): Promise<"clean" | "malicious"> {
  if (input.signal.aborted) throw new DocumentScannerUnavailable();
  const socket = input.socketFactory(input.host, input.port);
  const abort = () => socket.destroy(new DocumentScannerUnavailable());
  input.signal.addEventListener("abort", abort, { once: true });
  try {
    await connected(socket);
    const response = clamavResponse(socket);
    void response.catch(() => undefined);
    await write(socket, Buffer.from("zINSTREAM\0", "ascii"));
    const prefix = Buffer.alloc(8);
    let prefixLength = 0;
    let total = 0;
    for await (const value of input.body) {
      if (input.signal.aborted) throw new DocumentScannerUnavailable();
      const chunk = Buffer.from(value);
      if (chunk.length === 0) continue;
      total += chunk.length;
      if (!Number.isSafeInteger(total) || total > input.expectedSize) {
        throw new DocumentScannerUnavailable();
      }
      if (prefixLength < prefix.length) {
        const copied = chunk.copy(prefix, prefixLength, 0, prefix.length - prefixLength);
        prefixLength += copied;
      }
      const length = Buffer.allocUnsafe(4);
      length.writeUInt32BE(chunk.length);
      await write(socket, length);
      await write(socket, chunk);
    }
    if (total !== input.expectedSize) throw new DocumentScannerUnavailable();
    await write(socket, Buffer.alloc(4));
    const clamavVerdict = await response;
    const magicMatches = matchesMagic(
      prefix.subarray(0, prefixLength),
      input.contentType,
    );
    return clamavVerdict === "clean" && magicMatches ? "clean" : "malicious";
  } finally {
    input.signal.removeEventListener("abort", abort);
    socket.destroy();
  }
}

function connected(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off("connect", onConnect);
      socket.off("error", onError);
    };
    const onConnect = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new DocumentScannerUnavailable()); };
    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
}

function write(socket: Socket, value: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(value, (error) => {
      if (error) reject(new DocumentScannerUnavailable());
      else resolve();
    });
  });
}

function clamavResponse(socket: Socket): Promise<"clean" | "malicious"> {
  return new Promise((resolve, reject) => {
    let response = Buffer.alloc(0);
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const fail = () => { cleanup(); reject(new DocumentScannerUnavailable()); };
    const onError = () => fail();
    const onClose = () => fail();
    const onData = (chunk: Buffer) => {
      if (response.length + chunk.length > MAX_RESPONSE_BYTES) return fail();
      response = Buffer.concat([response, chunk]);
      if (!response.includes(0) && !response.includes(10)) return;
      const line = response.toString("utf8").split(/[\0\n]/u, 1)[0] ?? "";
      cleanup();
      if (/^stream: OK$/u.test(line)) resolve("clean");
      else if (/^stream: .+ FOUND$/u.test(line)) resolve("malicious");
      else reject(new DocumentScannerUnavailable());
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

function matchesMagic(prefix: Uint8Array, contentType: string): boolean {
  if (contentType === "application/pdf") {
    return Buffer.from(prefix).subarray(0, 5).equals(Buffer.from("%PDF-", "ascii"));
  }
  if (contentType === "image/jpeg") {
    return prefix.length >= 3 && prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff;
  }
  if (contentType === "image/png") {
    return Buffer.from(prefix).subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  }
  return false;
}
