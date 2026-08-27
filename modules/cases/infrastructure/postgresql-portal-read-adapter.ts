import "server-only";

import type { TenantTransaction } from "../../shared/server.ts";
import type { CasesPortalCaseFacts, CasesPortalReadPort, CasesPortalWorkspaceFacts } from "../application/portal-read-port.ts";

export class PostgreSqlCasesPortalReadAdapter implements CasesPortalReadPort {
  async readCaseFacts(transaction: TenantTransaction, input: { organizationId: string; serviceCaseId: string }): Promise<CasesPortalCaseFacts | null> {
    const result = await transaction.query<CasesPortalCaseFacts>({
      text: `SELECT student_id AS "studentId", primary_user_id AS "primaryUserId", COALESCE(workflow_status,'active') AS "workflowStatus",
        stage, updated_at::text AS "updatedAt"
        FROM cases_service_cases WHERE id=$1 AND organization_id=$2`,
      values: [input.serviceCaseId, input.organizationId],
    });
    return result.rows[0] ?? null;
  }

  async readWorkspaceFacts(transaction: TenantTransaction, input: { organizationId: string; serviceCaseId: string }): Promise<CasesPortalWorkspaceFacts | null> {
    const result = await transaction.query<any>({
      text: `SELECT service_case.student_id AS "studentId", service_case.primary_user_id AS "primaryUserId", COALESCE(service_case.workflow_status,'active') AS "workflowStatus",
        service_case.stage, service_case.updated_at::text AS "updatedAt",
        COALESCE((SELECT jsonb_agg(jsonb_build_object('schoolId', item.school_id, 'status', target.state) ORDER BY item.ordinal)
          FROM cases_candidate_school_list_versions AS version
          JOIN cases_candidate_school_list_items AS item ON item.list_version_id=version.id
          LEFT JOIN cases_school_targets AS target ON target.id=item.school_target_id
          WHERE version.service_case_id=service_case.id AND version.organization_id=$1
            AND version.status='confirmed' AND COALESCE(target.state,'candidate') <> 'withdrawn'), '[]'::jsonb) AS "schoolTargets",
        '[]'::jsonb AS "actionItems", '[]'::jsonb AS messages
        FROM cases_service_cases AS service_case
        WHERE service_case.id=$2 AND service_case.organization_id=$1`,
      values: [input.organizationId, input.serviceCaseId],
    });
    const row = result.rows[0];
    return row ? { ...row, actionItems: row.actionItems ?? [], messages: row.messages ?? [], schoolTargets: row.schoolTargets ?? [] } : null;
  }
}
