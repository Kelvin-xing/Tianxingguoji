import "server-only";

import { loadDocumentTransportConfig } from "../../../lib/runtime/document-transport-config.ts";
import { getApplicationTenantRunner } from "../../shared/server.ts";
import { DocumentTransferService } from "../application/transfer-service.ts";
import {
  DeterministicFakeDocumentTransport,
  getDeterministicFakeDocumentTransport,
} from "./deterministic-fake-transport.ts";
import { PostgresqlDocumentTransferRepository } from "./postgresql-transfer-repository.ts";

export interface DocumentTransferRuntime {
  readonly service: DocumentTransferService;
  readonly objectStore: DeterministicFakeDocumentTransport;
}

export class DocumentTransferRuntimeUnavailable extends Error {
  constructor() {
    super("Document transfer runtime is not configured.");
    this.name = "DocumentTransferRuntimeUnavailable";
  }
}

export function isDocumentTransferRuntimeUnavailable(
  value: unknown,
): value is DocumentTransferRuntimeUnavailable {
  return value instanceof Error && value.name === "DocumentTransferRuntimeUnavailable";
}

const globalForDocumentTransfer = globalThis as typeof globalThis & {
  __txDocumentTransferRuntime?: DocumentTransferRuntime;
};

export function getDocumentTransferRuntime(): DocumentTransferRuntime {
  try {
    const config = loadDocumentTransportConfig();
    if (config.mode !== "deterministic-fake") throw new DocumentTransferRuntimeUnavailable();
    if (globalForDocumentTransfer.__txDocumentTransferRuntime) {
      return globalForDocumentTransfer.__txDocumentTransferRuntime;
    }
    const objectStore = getDeterministicFakeDocumentTransport();
    const runtime = Object.freeze({
      objectStore,
      service: new DocumentTransferService({
        repository: new PostgresqlDocumentTransferRepository(getApplicationTenantRunner()),
        signer: objectStore,
        bucket: config.bucket,
        allowedHttpOrigin: config.origin,
      }),
    });
    globalForDocumentTransfer.__txDocumentTransferRuntime = runtime;
    return runtime;
  } catch (error) {
    if (error instanceof DocumentTransferRuntimeUnavailable) throw error;
    throw new DocumentTransferRuntimeUnavailable();
  }
}
