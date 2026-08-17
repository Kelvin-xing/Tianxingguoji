import type { DocumentScanService } from "../modules/documents/server.ts";
import { getDocumentScanRuntime } from "../modules/documents/server.ts";

export async function reconcileDocumentScans(
  input: { readonly staleAfterMs: number; readonly limit: number },
  dependencies: { readonly service: DocumentScanService } = getDocumentScanRuntime(),
) {
  return dependencies.service.reconcileDocumentScans(input);
}
