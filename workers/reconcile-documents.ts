import type { DocumentScanService } from "../modules/documents/scan-service.ts";
import { getDocumentScanRuntime } from "../modules/documents/scan-runtime.ts";

export async function reconcileDocumentScans(
  input: { readonly staleAfterMs: number; readonly limit: number },
  dependencies: { readonly service: DocumentScanService } = getDocumentScanRuntime(),
) {
  return dependencies.service.reconcileDocumentScans(input);
}
