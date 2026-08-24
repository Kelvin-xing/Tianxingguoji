import assert from "node:assert/strict";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import test from "node:test";

import {
  DocumentScannerUnavailable,
  LocalClamavDocumentScanner,
} from "../../../modules/documents/infrastructure/clamav-scanner.ts";
import type { DocumentObjectReader } from "../../../modules/documents/infrastructure/local-object-store.ts";

const BUCKET = "tianxing-documents-local";
const OBJECT = Object.freeze({
  requestId: "doc02-clamav-1",
  objectKey: "documents/81000000-0000-4000-8000-000000000001/versions/81000000-0000-4000-8000-000000000002",
  objectVersionId: "provider-v1",
});
const PDF = Buffer.from("%PDF-1.7", "ascii");

test("streams one exact object through ClamAV and combines verdict with bounded magic bytes", async (t) => {
  const cleanServer = await clamServer("stream: OK\0");
  t.after(() => closeServer(cleanServer.server));
  const clean = scanner(cleanServer.port, reader(PDF, "application/pdf"));
  assert.deepEqual(await clean.scan(OBJECT), {
    ...OBJECT,
    verdict: "clean",
    scannerVersion: "clamav-release1",
  });

  const mismatch = scanner(cleanServer.port, reader(Buffer.from("not-pdf!"), "application/pdf"));
  assert.equal((await mismatch.scan(OBJECT)).verdict, "malicious");

  const maliciousServer = await clamServer("stream: Eicar-Test-Signature FOUND\0");
  t.after(() => closeServer(maliciousServer.server));
  assert.equal(
    (await scanner(maliciousServer.port, reader(PDF, "application/pdf")).scan(OBJECT)).verdict,
    "malicious",
  );
});

test("one total deadline aborts a pending object HEAD before any socket work", async () => {
  let headAborted = false;
  let readCalled = false;
  const pendingReader: DocumentObjectReader = {
    async headExact(input) {
      await new Promise<never>((_resolve, reject) => {
        input.signal?.addEventListener("abort", () => {
          headAborted = true;
          reject(new Error("aborted"));
        }, { once: true });
      });
      throw new Error("unreachable");
    },
    async readExact() {
      readCalled = true;
      throw new Error("must not read");
    },
  };
  const value = new LocalClamavDocumentScanner({
    reader: pendingReader,
    bucket: BUCKET,
    host: "127.0.0.1",
    port: 9,
    timeoutMs: 20,
  });
  await assert.rejects(() => value.scan(OBJECT), DocumentScannerUnavailable);
  assert.equal(headAborted, true);
  assert.equal(readCalled, false);
});

test("one total deadline cancels both the object stream and an open ClamAV socket", async (t) => {
  let socketClosed = false;
  let resolveSocketClosed: (() => void) | null = null;
  const socketClosedEvent = new Promise<void>((resolve) => {
    resolveSocketClosed = resolve;
  });
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  const port = await listen(server);
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await closeServer(server);
  });

  let streamAborted = false;
  const pendingReader: DocumentObjectReader = {
    async headExact() {
      return { sizeBytes: PDF.length, contentType: "application/pdf", checksumSha256Base64: "x" };
    },
    async readExact(input) {
      return (async function* () {
        yield PDF;
        await new Promise<void>((resolve) => {
          input.signal?.addEventListener("abort", () => {
            streamAborted = true;
            resolve();
          }, { once: true });
        });
      })();
    },
  };
  const value = new LocalClamavDocumentScanner({
    reader: pendingReader,
    bucket: BUCKET,
    host: "127.0.0.1",
    port,
    timeoutMs: 30,
    socketFactory(host, targetPort) {
      const socket = createConnection({ host, port: targetPort });
      socket.on("close", () => {
        socketClosed = true;
        resolveSocketClosed?.();
      });
      return socket;
    },
  });
  await assert.rejects(() => value.scan(OBJECT), DocumentScannerUnavailable);
  await Promise.race([
    socketClosedEvent,
    new Promise((resolve) => setTimeout(resolve, 500)),
  ]);
  assert.equal(streamAborted, true);
  assert.equal(socketClosed, true);
});

function scanner(port: number, objectReader: DocumentObjectReader) {
  return new LocalClamavDocumentScanner({
    reader: objectReader,
    bucket: BUCKET,
    host: "127.0.0.1",
    port,
    timeoutMs: 1_000,
  });
}

function reader(bytes: Uint8Array, contentType: string): DocumentObjectReader {
  return {
    async headExact() {
      return { sizeBytes: bytes.length, contentType, checksumSha256Base64: "x" };
    },
    async readExact() {
      return (async function* () { yield bytes; })();
    },
  };
}

async function clamServer(response: string): Promise<{ server: Server; port: number }> {
  const server = createServer((socket) => {
    let pending = Buffer.alloc(0);
    socket.on("data", (value) => {
      pending = Buffer.concat([pending, value]);
      if (pending.length < 10 || pending.subarray(0, 10).toString("ascii") !== "zINSTREAM\0") return;
      let offset = 10;
      while (pending.length >= offset + 4) {
        const size = pending.readUInt32BE(offset);
        if (size === 0) {
          socket.end(response);
          return;
        }
        if (pending.length < offset + 4 + size) return;
        offset += 4 + size;
      }
    });
  });
  return { server, port: await listen(server) };
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("missing test port"));
      resolve(address.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
