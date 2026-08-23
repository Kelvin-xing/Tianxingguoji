import "server-only";

import { loadRuntimeEnvironment } from "../../../lib/runtime/runtime-environment.ts";
import { getApplicationTenantRunner } from "../../shared/server.ts";
import { DocumentWorkspaceService } from "../application/workspace-service.ts";
import { PostgresqlDocumentWorkspaceRepository } from "./postgresql-workspace-repository.ts";

export interface DocumentWorkspaceRuntime {
  readonly service: DocumentWorkspaceService;
}

export class DocumentWorkspaceRuntimeUnavailable extends Error {
  constructor() {
    super("Document workspace runtime is not configured.");
    this.name = "DocumentWorkspaceRuntimeUnavailable";
  }
}

export function isDocumentWorkspaceRuntimeUnavailable(
  value: unknown,
): value is DocumentWorkspaceRuntimeUnavailable {
  return value instanceof Error && value.name === "DocumentWorkspaceRuntimeUnavailable";
}

const globalForDocuments = globalThis as typeof globalThis & {
  __txDocumentWorkspaceRuntimes?: Map<string, DocumentWorkspaceRuntime>;
};

export function getDocumentWorkspaceRuntime(): DocumentWorkspaceRuntime {
  const mode = loadRuntimeEnvironment().appRuntimeMode;
  if (mode === "production-aws") throw new DocumentWorkspaceRuntimeUnavailable();

  const runtimes = globalForDocuments.__txDocumentWorkspaceRuntimes ??
    new Map<string, DocumentWorkspaceRuntime>();
  globalForDocuments.__txDocumentWorkspaceRuntimes = runtimes;
  let runtime = runtimes.get(mode);
  if (!runtime) {
    try {
      runtime = Object.freeze({
        service: new DocumentWorkspaceService(
          new PostgresqlDocumentWorkspaceRepository(getApplicationTenantRunner()),
        ),
      });
    } catch {
      throw new DocumentWorkspaceRuntimeUnavailable();
    }
    runtimes.set(mode, runtime);
  }
  return runtime;
}
