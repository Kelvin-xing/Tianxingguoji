import type { DocumentObjectHead } from "../application/object-receipt-service.ts";

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
