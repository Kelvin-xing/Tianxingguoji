import type { BackfillPreview } from "./backfill-preview-contract.ts";

export type ImportLedgerEntry = Readonly<{
  ledgerVersion: 1;
  status: "awaiting_data_owner_approval";
  resumeKey: string;
  source: Readonly<{
    kind: "synthetic";
    version: string;
    sha256: string;
  }>;
  mapping: Readonly<{
    version: string;
    sha256: string;
  }>;
  schemaVersion: string;
  reportSha256: string;
}>;

export type BackfillBatchApproval = {
  approvedByRole: "data_owner";
  approvedBatchReportSha256: string;
  approvalReference: string;
};

export class BackfillLedgerContractError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "BackfillLedgerContractError";
    this.code = code;
  }
}

export function createImportLedgerEntry(preview: BackfillPreview): ImportLedgerEntry {
  if (
    preview.execution.mode !== "preview_only" ||
    preview.execution.sourceWrites !== "forbidden" ||
    preview.execution.targetWrites !== "forbidden"
  ) {
    throw new BackfillLedgerContractError("BACKFILL_WRITE_MODE_FORBIDDEN");
  }
  if (
    preview.rejections.length > 0 ||
    preview.reconciliation.status !== "reconciled" ||
    preview.reconciliation.unexplainedDifference !== 0
  ) {
    throw new BackfillLedgerContractError("BACKFILL_REJECTS_PRESENT");
  }
  const source = Object.freeze({
    kind: preview.source.kind,
    version: preview.source.version,
    sha256: preview.hashes.sourceSha256,
  });
  const mapping = Object.freeze({
    version: preview.mapping.version,
    sha256: preview.hashes.mappingSha256,
  });
  return Object.freeze({
    ledgerVersion: 1,
    status: "awaiting_data_owner_approval",
    resumeKey: preview.resumeKey,
    source,
    mapping,
    schemaVersion: preview.schemaVersion,
    reportSha256: preview.hashes.reportSha256,
  });
}

export function evaluateBackfillResume(
  ledger: ImportLedgerEntry,
  preview: BackfillPreview,
):
  | { action: "replay" }
  | { action: "new_batch_required" }
  | { action: "conflict"; code: "BACKFILL_RESUME_PAYLOAD_CONFLICT" } {
  if (ledger.resumeKey !== preview.resumeKey) {
    return { action: "new_batch_required" };
  }
  if (ledger.reportSha256 !== preview.hashes.reportSha256) {
    return { action: "conflict", code: "BACKFILL_RESUME_PAYLOAD_CONFLICT" };
  }
  return { action: "replay" };
}

export function assertExactBatchApproval(
  ledger: ImportLedgerEntry,
  approval: BackfillBatchApproval | null,
): void {
  if (approval === null || approval.approvedByRole !== "data_owner") {
    throw new BackfillLedgerContractError("BACKFILL_MAPPING_APPROVAL_REQUIRED");
  }
  if (
    approval.approvedBatchReportSha256 !== ledger.reportSha256 ||
    typeof approval.approvalReference !== "string" ||
    approval.approvalReference.trim().length === 0
  ) {
    throw new BackfillLedgerContractError("BACKFILL_APPROVAL_PAYLOAD_MISMATCH");
  }
}
