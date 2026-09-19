import "server-only";

import { loadDocumentTransportConfig } from "../../../lib/runtime/document-transport-config.ts";
import { getApplicationTenantRunner } from "../../shared/server.ts";
import type { IdentitySessionActor } from "../../identity/public.ts";
import { DocumentTransferError } from "../application/transfer-service.ts";
import { DocumentTransferService } from "../application/transfer-service.ts";
import {
  DeterministicFakeDocumentTransport,
  getDeterministicFakeDocumentTransport,
} from "./deterministic-fake-transport.ts";
import { PostgresqlDocumentTransferRepository } from "./postgresql-transfer-repository.ts";

export interface DocumentTransferRuntime {
  readonly service: DocumentTransferService;
  readonly resolveTaskCase:(actor:IdentitySessionActor,taskId:string,documentId:string)=>Promise<string>;
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
      resolveTaskCase:async(actor:IdentitySessionActor,taskId:string,documentId:string)=>{
        const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
        if(!uuid.test(taskId)||!uuid.test(documentId))throw new DocumentTransferError('DOCUMENT_TRANSFER_INVALID');
        return getApplicationTenantRunner().run({organizationId:actor.organizationId,actorUserId:actor.userId},async tx=>{
          const row=(await tx.query<{service_case_id:string}>({text:`SELECT t.service_case_id FROM tasks_tasks t
            JOIN documents_documents d ON d.service_case_id=t.service_case_id AND d.organization_id=t.organization_id
            WHERE t.id=$1 AND d.id=$2 AND t.organization_id=$3 AND d.owner_kind='case'`,values:[taskId,documentId,actor.organizationId]})).rows[0];
          if(!row)throw new DocumentTransferError('DOCUMENT_TRANSFER_NOT_FOUND');
          return row.service_case_id;
        });
      },
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
