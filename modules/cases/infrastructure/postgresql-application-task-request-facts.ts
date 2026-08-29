import "server-only";

import type {
  ApplicationTaskRequestFacts,
  ApplicationTaskRequestRef,
  CasesApplicationTaskRequestFactsPort,
  TaskFactsTransaction,
} from "../../shared/public.ts";

export class PostgresqlCasesApplicationTaskRequestFactsPort
implements CasesApplicationTaskRequestFactsPort {
  async listForCandidateVersion(transaction: TaskFactsTransaction, input: Readonly<{
    organizationId: string; caseId: string; versionId: string;
  }>): Promise<readonly ApplicationTaskRequestRef[]> {
    const result = await transaction.query<RequestRefRow>({
      text: `SELECT outbox.audit_event_id AS source_event_id,item.school_target_id AS target_id
               FROM cases_candidate_school_list_items AS item
               JOIN audit_outbox AS outbox
                 ON outbox.organization_id=item.organization_id
                AND outbox.aggregate_id=item.school_target_id
                AND outbox.event_type='cases.application_task_requested'
                AND outbox.event_version=2
              WHERE item.organization_id=$1 AND item.service_case_id=$2
                AND item.list_version_id=$3
              ORDER BY item.ordinal,outbox.audit_event_id`,
      values: [input.organizationId,input.caseId,input.versionId],
    });
    return Object.freeze(result.rows.map((row) => Object.freeze({
      sourceEventId: row.source_event_id,
      targetId: row.target_id,
    })));
  }

  async readRequestFacts(transaction: TaskFactsTransaction, input: Readonly<{
    organizationId: string; targetId: string; sourceEventId: string;
  }>): Promise<ApplicationTaskRequestFacts | null> {
    const result = await transaction.query<RequestFactRow>({
      text: `SELECT fact.id AS source_event_id,target.id AS target_id,
                    target.service_case_id AS case_id,target.application_round,
                    target.application_deadline,fact.application_deadline AS fact_deadline,
                    target.record_version AS target_record_version,
                    assignment.id AS assignment_id,assignment.assignee_user_id,
                    assignment.assignee_role,
                    assignment.assignee_membership_id,assignment.advisor_role_binding_id,
                    service_case.primary_user_id AS owner_user_id,
                    fact.actor_user_id AS source_actor_user_id
               FROM cases_school_target_transition_facts AS fact
               JOIN cases_school_targets AS target
                 ON target.id=fact.school_target_id
                AND target.organization_id=fact.organization_id
                AND target.service_case_id=fact.service_case_id
               JOIN cases_service_cases AS service_case
                 ON service_case.id=target.service_case_id
                AND service_case.organization_id=target.organization_id
               JOIN cases_school_target_assignments AS assignment
                 ON assignment.id=target.current_assignment_id
                AND assignment.organization_id=target.organization_id
                AND assignment.school_target_id=target.id
               JOIN access_organization_memberships AS membership
                 ON membership.id=assignment.assignee_membership_id
                AND membership.organization_id=assignment.organization_id
                AND membership.user_id=assignment.assignee_user_id
               JOIN access_role_bindings AS binding
                 ON binding.id=assignment.advisor_role_binding_id
                AND binding.organization_id=assignment.organization_id
                AND binding.membership_id=assignment.assignee_membership_id
                AND binding.user_id=assignment.assignee_user_id
                AND binding.role=assignment.assignee_role
              WHERE fact.organization_id=$1 AND fact.school_target_id=$2 AND fact.id=$3
                AND fact.from_state='candidate' AND fact.to_state='preparing'
                AND target.state='preparing'
                AND assignment.ends_at IS NULL
                AND membership.status='active' AND binding.status='active'
                AND service_case.workflow_status='active'
                AND service_case.stage='application_in_progress'
              FOR SHARE OF fact,target,service_case,assignment,membership,binding`,
      values: [input.organizationId,input.targetId,input.sourceEventId],
    });
    const row = result.rows[0];
    if (!row || !sameInstant(row.application_deadline,row.fact_deadline)) return null;
    const deadline = row.application_deadline === null
      ? null : new Date(row.application_deadline).toISOString();
    return Object.freeze({
      sourceEventId: row.source_event_id,targetId: row.target_id,caseId: row.case_id,
      applicationRound: Number(row.application_round),applicationDeadline: deadline,
      assignmentId: row.assignment_id,assigneeUserId: row.assignee_user_id,
      assigneeRole: row.assignee_role as "advisor" | "contractor",
      assigneeMembershipId: row.assignee_membership_id,
      assigneeRoleBindingId: row.advisor_role_binding_id,ownerUserId: row.owner_user_id,
      sourceActorUserId: row.source_actor_user_id,
      targetRecordVersion: Number(row.target_record_version),
    });
  }
}

interface RequestRefRow { readonly source_event_id: string; readonly target_id: string }
interface RequestFactRow extends RequestRefRow {
  readonly case_id: string; readonly application_round: number | string;
  readonly application_deadline: Date | string | null;
  readonly fact_deadline: Date | string | null;
  readonly target_record_version: number | string; readonly assignment_id: string;
  readonly assignee_user_id: string; readonly assignee_role: string; readonly assignee_membership_id: string;
  readonly advisor_role_binding_id: string; readonly owner_user_id: string;
  readonly source_actor_user_id: string;
}
function sameInstant(left: Date | string | null,right: Date | string | null): boolean {
  if (left === null || right === null) return left === right;
  return new Date(left).getTime() === new Date(right).getTime();
}
