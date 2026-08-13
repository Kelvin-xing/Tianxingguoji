import type { TenantDatabaseContext, TenantTransactionRunner } from "../shared/db.ts";
import {
  runSupportingModuleTransaction,
  SupportingRepositoryError,
} from "../audit/production-repository.ts";

export interface AvailableDocumentObject {
  readonly documentId: string;
  readonly versionId: string;
  readonly bucket: string;
  readonly key: string;
  readonly objectVersionId: string | null;
}

/** Returns an object reference only while both the document and version remain available. */
export async function readAvailableDocumentObject(input: {
  readonly runner: TenantTransactionRunner;
  readonly context: TenantDatabaseContext;
  readonly documentId: string;
  readonly versionId: string;
}): Promise<AvailableDocumentObject> {
  return runSupportingModuleTransaction({
    runner: input.runner,
    module: "documents",
    context: input.context,
    operation: async (transaction) => {
      const rows = await transaction.query<AvailableDocumentObject>({
        text: `SELECT d.id AS "documentId", v.id AS "versionId", v.object_bucket AS bucket,
          v.object_key AS key, v.object_version_id AS "objectVersionId"
          FROM documents_documents d
          JOIN documents_document_versions v ON v.document_id = d.id AND v.organization_id = d.organization_id
          WHERE d.id = $1 AND v.id = $2 AND d.lifecycle_state = 'active'
            AND v.state = 'available' AND v.revoked_at IS NULL
          FOR SHARE`,
        values: [input.documentId, input.versionId],
      });
      if (rows.length !== 1) {
        throw new SupportingRepositoryError("SUPPORTING_DOCUMENT_UNAVAILABLE");
      }
      return Object.freeze({ ...rows[0] });
    },
  });
}
