import "server-only";

import type { CasesTaskFactsPort, TaskFactsTransaction } from "../../shared/public.ts";

/** Public Cases transaction fact port consumed by Tasks.  The SQL is kept in
 * Cases so Tasks never reaches into Cases' private tables. */
export class PostgresqlCasesTaskFactsPort implements CasesTaskFactsPort {
  async readCurrentTargetTaskFacts(transaction: TaskFactsTransaction, input: Readonly<{ organizationId: string; caseId: string; targetId: string }>) {
    const target = await transaction.query<{ current_assignment_id: string | null }>({
      text: `SELECT current_assignment_id FROM cases_school_targets
              WHERE organization_id=$1 AND service_case_id=$2 AND id=$3 FOR SHARE`,
      values: [input.organizationId, input.caseId, input.targetId],
    });
    const assignmentId = target.rows[0]?.current_assignment_id;
    if (!assignmentId) return null;
    return this.readTargetTaskFacts(transaction, { ...input, assignmentId });
  }

  async readTargetTaskFacts(transaction: TaskFactsTransaction, input: Readonly<{
    organizationId: string; caseId: string; targetId: string; assignmentId: string;
  }>) {
    const result = await transaction.query<CaseTaskFactRow>({
      text: `SELECT target.service_case_id AS case_id, target.id AS target_id,
                    assignment.id AS assignment_id, target.state,
                    assignment.assignee_user_id, assignment.assignee_role,
                    assignment.assignee_membership_id, assignment.advisor_role_binding_id,
                    service_case.stage AS case_stage, service_case.workflow_status,
                    service_case.primary_user_id AS owner_user_id,
                    (assignment.assignee_user_id = service_case.primary_user_id
                      AND assignment.assignee_role = 'advisor') AS is_primary_advisor,
                    assignment.case_collaborator_id
               FROM cases_school_targets AS target
               JOIN cases_service_cases AS service_case
                 ON service_case.id = target.service_case_id
                AND service_case.organization_id = target.organization_id
               JOIN cases_school_target_assignments AS assignment
                 ON assignment.id = target.current_assignment_id
                AND assignment.organization_id = target.organization_id
              WHERE target.organization_id = $1 AND target.service_case_id = $2
                AND target.id = $3 AND assignment.id = $4
              FOR SHARE OF target, service_case, assignment`,
      values: [input.organizationId, input.caseId, input.targetId, input.assignmentId],
    });
    const row = result.rows[0];
    if (!row || !["advisor", "contractor"].includes(row.assignee_role)) return null;
    return Object.freeze({
      caseId: row.case_id, targetId: row.target_id, assignmentId: row.assignment_id,
      state: row.state, assigneeUserId: row.assignee_user_id,
      assigneeRole: row.assignee_role as "advisor" | "contractor",
      assigneeMembershipId: row.assignee_membership_id,
      assigneeRoleBindingId: row.advisor_role_binding_id,
      caseStage: row.case_stage, workflowStatus: row.workflow_status,
      ownerUserId: row.owner_user_id, isPrimaryAdvisor: row.is_primary_advisor,
      collaboratorId: row.case_collaborator_id,
    });
  }
}

interface CaseTaskFactRow {
  readonly case_id: string; readonly target_id: string; readonly assignment_id: string;
  readonly state: string; readonly assignee_user_id: string;
  readonly assignee_role: string; readonly assignee_membership_id: string;
  readonly advisor_role_binding_id: string; readonly case_stage: string;
  readonly workflow_status: string; readonly owner_user_id: string;
  readonly is_primary_advisor: boolean; readonly case_collaborator_id: string | null;
}
