import "server-only";

import type { DocumentsCleanEvidencePort, TaskFactsTransaction } from "../../shared/public.ts";

/** Documents owns evidence state. Tasks asks this port for a clean, active
 * case document and never reads document tables itself. */
export class PostgresqlCleanTaskEvidencePort implements DocumentsCleanEvidencePort {
  async readCleanCaseEvidence(transaction: TaskFactsTransaction, input: Readonly<{
    organizationId: string; caseId: string; targetId: string; taskId: string; evidenceId: string;
  }>): Promise<boolean> {
    const result = await transaction.query<{ clean: boolean }>({
      text: `SELECT EXISTS (
               SELECT 1
                 FROM documents_documents AS document
                 JOIN documents_document_versions AS version
                   ON version.id = document.active_document_version_id
                  AND version.organization_id = document.organization_id
                WHERE document.id = $1 AND document.organization_id = $2
                  AND document.owner_kind = 'case' AND document.service_case_id = $3
                  AND document.lifecycle_state = 'active' AND document.soft_deleted_at IS NULL
                  AND version.state = 'available' AND version.revoked_at IS NULL
             ) AS clean`,
      values: [input.evidenceId, input.organizationId, input.caseId],
    });
    return result.rows[0]?.clean === true;
  }
}
