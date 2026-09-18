import "server-only";

import type { DocumentsCleanEvidencePort, TaskFactsTransaction } from "../../shared/public.ts";

/** Documents owns evidence state. Tasks asks this port for a clean, active
 * case document and never reads document tables itself. */
export class PostgresqlCleanTaskEvidencePort implements DocumentsCleanEvidencePort {
  async readCleanCaseDocument(transaction: TaskFactsTransaction, input: Readonly<{
    organizationId: string; caseId: string; documentId: string;
  }>): Promise<boolean> {
    const result = await transaction.query<{clean:boolean}>({text:`SELECT true AS clean
      FROM documents_documents document JOIN documents_document_versions version
        ON version.id=document.active_document_version_id AND version.organization_id=document.organization_id AND version.document_id=document.id
      WHERE document.id=$1 AND document.organization_id=$2 AND document.owner_kind='case' AND document.service_case_id=$3
        AND document.lifecycle_state='active' AND document.soft_deleted_at IS NULL AND version.state='available' AND version.revoked_at IS NULL
      FOR SHARE OF document,version`,values:[input.documentId,input.organizationId,input.caseId]});
    return result.rows[0]?.clean===true;
  }

  async readCleanCaseEvidence(transaction: TaskFactsTransaction, input: Readonly<{
    organizationId: string; caseId: string; targetId: string; taskId: string; evidenceId: string; actorUserId?: string;
  }>): Promise<boolean> {
    const result = await transaction.query<{ clean: boolean }>({
      text: `SELECT true AS clean
                 FROM documents_documents AS document
                 JOIN documents_document_versions AS version
                   ON version.id = document.active_document_version_id
                  AND version.organization_id = document.organization_id AND version.document_id=document.id
                WHERE document.id = $1 AND document.organization_id = $2
                  AND document.owner_kind = 'case' AND document.service_case_id = $3
                  AND document.lifecycle_state = 'active' AND document.soft_deleted_at IS NULL
                  AND version.state = 'available' AND version.revoked_at IS NULL
                  AND ($4::uuid IS NULL OR EXISTS (
                    SELECT 1 FROM documents_task_links link
                    JOIN tasks_tasks task ON task.id=link.task_id AND task.organization_id=link.organization_id
                    JOIN tasks_task_assignments assignment ON assignment.task_id=task.id AND assignment.organization_id=task.organization_id
                    JOIN access_trial_members member ON member.user_id=assignment.assignee_user_id AND member.organization_id=task.organization_id
                    JOIN identity_users actor ON actor.id=member.user_id AND actor.status='active'
                    JOIN access_organization_memberships membership ON membership.id=member.membership_id AND membership.organization_id=member.organization_id AND membership.status='active'
                    JOIN access_organizations organization ON organization.id=member.organization_id AND organization.status='active'
                    JOIN access_role_bindings binding ON binding.id=assignment.assignee_role_binding_id AND binding.organization_id=member.organization_id AND binding.user_id=member.user_id AND binding.role='l3' AND binding.status='active'
                    WHERE link.document_id=document.id AND link.organization_id=document.organization_id
                      AND link.task_id=$5 AND 'document.read'=ANY(link.allowed_actions)
                      AND task.service_case_id=$3 AND task.school_target_id=$6 AND task.task_kind='application_prepare_submit'
                      AND task.state='accepted' AND assignment.assignee_user_id=$4
                      AND assignment.assignee_role='l3' AND assignment.redaction_profile='task_only'
                      AND assignment.ended_at IS NULL AND assignment.status='accepted'
                      AND member.status='active' AND member.level='l3'
                  ))
             FOR SHARE OF document,version`,
      values: [input.evidenceId, input.organizationId, input.caseId, input.actorUserId ?? null, input.taskId, input.targetId],
    });
    return result.rows[0]?.clean === true;
  }
}
