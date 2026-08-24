import "server-only";

import { loadLocalSyntheticConfig } from "../../../lib/runtime/local-synthetic-config.ts";
import { loadRuntimeEnvironment } from "../../../lib/runtime/runtime-environment.ts";
import { getApplicationTenantRunner } from "../../shared/server.ts";
import { DocumentTransferService } from "../application/transfer-service.ts";
import { LocalSyntheticDocumentObjectStore } from "./local-object-store.ts";
import { PostgresqlDocumentTransferRepository } from "./postgresql-transfer-repository.ts";

export interface DocumentTransferRuntime {
  readonly service: DocumentTransferService;
  readonly objectStore: LocalSyntheticDocumentObjectStore;
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
  if (loadRuntimeEnvironment().appRuntimeMode !== "local-synthetic") {
    throw new DocumentTransferRuntimeUnavailable();
  }
  if (globalForDocumentTransfer.__txDocumentTransferRuntime) {
    return globalForDocumentTransfer.__txDocumentTransferRuntime;
  }
  try {
    const config = loadLocalSyntheticConfig();
    const objectStore = new LocalSyntheticDocumentObjectStore({
      endpoint: config.localstack.endpoint,
      bucket: config.localstack.bucket,
      requestTimeoutMs: config.dependencyTimeoutMs,
    });
    const runtime = Object.freeze({
      objectStore,
      service: new DocumentTransferService({
        repository: new PostgresqlDocumentTransferRepository(getApplicationTenantRunner()),
        signer: objectStore,
        bucket: config.localstack.bucket,
        allowedHttpOrigin: config.localstack.endpoint,
      }),
    });
    globalForDocumentTransfer.__txDocumentTransferRuntime = runtime;
    return runtime;
  } catch {
    throw new DocumentTransferRuntimeUnavailable();
  }
}
