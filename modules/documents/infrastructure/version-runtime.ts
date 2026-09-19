import "server-only";

import { DocumentVersionService } from "../application/version-service.ts";
import { PostgresqlDocumentVersionRepository } from "./postgresql-version-repository.ts";
import { getApplicationTenantRunner } from "../../shared/server.ts";
import { loadRuntimeEnvironment } from "../../../lib/runtime/runtime-environment.ts";

export interface DocumentVersionRuntime {
  readonly service: DocumentVersionService;
  readonly history:PostgresqlDocumentVersionRepository['history'];
}

export class DocumentVersionRuntimeUnavailable extends Error {
  constructor() {
    super("Document version runtime is not configured.");
    this.name = "DocumentVersionRuntimeUnavailable";
  }
}

/** Uses the configured PostgreSQL runner; no object-store or in-memory fallback. */
export function getDocumentVersionRuntime(): DocumentVersionRuntime {
  try {
    if(loadRuntimeEnvironment().appRuntimeMode==='production-aws')throw new DocumentVersionRuntimeUnavailable();
    const repository=new PostgresqlDocumentVersionRepository(getApplicationTenantRunner());
    return {service:new DocumentVersionService({repository}),history:input=>repository.history(input)};
  }catch {throw new DocumentVersionRuntimeUnavailable();}
}
