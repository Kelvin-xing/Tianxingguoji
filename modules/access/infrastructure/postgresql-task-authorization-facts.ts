import "server-only";

import type { AccessTaskFactsPort, TaskFactsKind, TaskFactsTransaction } from "../../shared/public.ts";

/** Access-owned authorization facts for the Tasks public transaction port. */
export class PostgresqlAccessTaskFactsPort implements AccessTaskFactsPort {
  async readActorBindingFacts(transaction: TaskFactsTransaction, input: Readonly<{ organizationId: string; userId: string }>) {
    const result = await transaction.query<BindingRow>({
      text: `SELECT binding.role, membership.id AS membership_id, binding.id AS role_binding_id
               FROM access_organization_memberships AS membership
               JOIN access_role_bindings AS binding
                 ON binding.membership_id = membership.id
                AND binding.organization_id = membership.organization_id
                AND binding.user_id = membership.user_id
              WHERE membership.organization_id = $1 AND membership.user_id = $2
                AND membership.status = 'active' AND binding.status = 'active'
                AND binding.role IN ('founder','advisor','contractor')
              ORDER BY binding.role, binding.id
              FOR SHARE OF membership, binding`,
      values: [input.organizationId, input.userId],
    });
    if (result.rows.length === 0) return null;
    return Object.freeze({ bindings: Object.freeze(result.rows.map((row) => Object.freeze({
      role: row.role as "founder" | "advisor" | "contractor",
      membershipId: row.membership_id, roleBindingId: row.role_binding_id,
    }))) });
  }

  async canAssigneeOperate(transaction: TaskFactsTransaction, input: Readonly<{
    organizationId: string; caseId: string; userId: string; kind: TaskFactsKind;
    assigneeRole: "advisor" | "contractor"; isPrimaryAdvisor: boolean; collaboratorId: string | null;
  }>): Promise<boolean> {
    if (input.kind === "application_prepare_submit" && input.assigneeRole !== "advisor") return false;
    if (input.kind === "interview_support" && !["advisor", "contractor"].includes(input.assigneeRole)) return false;
    if (input.assigneeRole === "advisor" && input.isPrimaryAdvisor) return true;
    if (input.kind === "interview_support" && input.assigneeRole === "contractor") {
      const contractor = await transaction.query<{ allowed: boolean }>({
        text: `SELECT EXISTS (
                 SELECT 1 FROM access_organization_memberships AS membership
                 JOIN access_role_bindings AS binding
                   ON binding.membership_id=membership.id
                  AND binding.organization_id=membership.organization_id
                  AND binding.user_id=membership.user_id
                WHERE membership.organization_id=$1 AND membership.user_id=$2
                  AND membership.status='active' AND binding.role='contractor' AND binding.status='active'
               ) AS allowed`,
        values: [input.organizationId, input.userId],
      });
      return contractor.rows[0]?.allowed === true;
    }
    if (input.collaboratorId === null) return false;
    const result = await transaction.query<{ allowed: boolean }>({
      text: `SELECT EXISTS (
               SELECT 1 FROM access_case_collaborators AS collaborator
               JOIN access_organization_memberships AS membership
                 ON membership.id = collaborator.membership_id
                AND membership.organization_id = collaborator.organization_id
                AND membership.user_id = collaborator.user_id
               JOIN access_role_bindings AS binding
                 ON binding.id = collaborator.advisor_role_binding_id
                AND binding.organization_id = collaborator.organization_id
              WHERE collaborator.id = $1 AND collaborator.organization_id = $2
                AND collaborator.case_id = $3 AND collaborator.user_id = $4
                AND collaborator.status = 'active'
                AND collaborator.starts_at <= transaction_timestamp()
                AND collaborator.expires_at > transaction_timestamp()
                AND membership.status = 'active' AND binding.status = 'active'
                AND binding.role = 'advisor'
             ) AS allowed`,
      values: [input.collaboratorId, input.organizationId, input.caseId, input.userId],
    });
    return result.rows[0]?.allowed === true;
  }
}

interface BindingRow { readonly role: string; readonly membership_id: string; readonly role_binding_id: string; }
