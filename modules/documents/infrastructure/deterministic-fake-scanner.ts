import "server-only";

import { DOCUMENT_UPLOAD_MAX_BYTES } from "../domain/contract.ts";
import type { DocumentScanner } from "./scan-runtime.ts";
import type { DocumentObjectReader } from "./object-transport-port.ts";

const EICAR_MARKER = Buffer.from("EICAR-STANDARD-ANTIVIRUS-TEST-FILE", "ascii");

export class DeterministicFakeDocumentScanner implements DocumentScanner {
  readonly scannerVersion = "deterministic-fake-release1" as const;
  private readonly reader: DocumentObjectReader;
  private readonly bucket: string;

  constructor(input: { readonly reader: DocumentObjectReader; readonly bucket: string }) {
    this.reader = input.reader;
    this.bucket = input.bucket;
  }

  async scan(input: {
    readonly requestId: string;
    readonly objectKey: string;
    readonly objectVersionId: string;
  }) {
    const source = await this.reader.readExact({
      bucket: this.bucket,
      key: input.objectKey,
      providerVersionId: input.objectVersionId,
    });
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of source) {
      size += chunk.byteLength;
      if (size > DOCUMENT_UPLOAD_MAX_BYTES) {
        return result(input, "malicious", this.scannerVersion);
      }
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), size);
    const validMagic = bytes.subarray(0, 5).equals(Buffer.from("%PDF-", "ascii")) ||
      (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) ||
      bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    return result(
      input,
      validMagic && !bytes.includes(EICAR_MARKER) ? "clean" : "malicious",
      this.scannerVersion,
    );
  }
}

function result(
  input: { readonly requestId: string; readonly objectKey: string; readonly objectVersionId: string },
  verdict: "clean" | "malicious",
  scannerVersion: "deterministic-fake-release1",
) {
  return Object.freeze({ ...input, verdict, scannerVersion });
}
