import { hasRequestCapability, type RequestAccessActor } from "../../access/public.ts";
import { evaluateDocumentVersionDownload, type DocumentRecord, type DocumentVersionRecord } from "./contract.ts";

export function canUseCaseDocument(input: Readonly<{
  actor: RequestAccessActor;
  isPrimaryAdvisor: boolean;
  isApplicationAssignee: boolean;
  isContractor: boolean;
  operation: "read" | "upload" | "download";
}>): boolean {
  if (input.isContractor) return false;
  const capability = input.operation === "read" ? "documents.read" :
    input.operation === "upload" ? "documents.upload" : "documents.download";
  if (!hasRequestCapability(input.actor, capability)) return false;
  return input.isPrimaryAdvisor || input.isApplicationAssignee;
}

export function canDownloadCleanVersion(input: Readonly<{
  actor: RequestAccessActor;
  isPrimaryAdvisor: boolean;
  isApplicationAssignee: boolean;
  isContractor: boolean;
  document: DocumentRecord;
  version: DocumentVersionRecord;
}>): boolean {
  return canUseCaseDocument({ ...input, operation: "download" }) &&
    evaluateDocumentVersionDownload({ document: input.document, version: input.version }).allowed;
}
