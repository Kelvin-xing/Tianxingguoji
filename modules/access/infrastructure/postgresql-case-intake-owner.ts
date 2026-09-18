import "server-only";

import { evaluateTrialAccess, type K12BusinessCategory } from "../domain/trial-policy.ts";
import { loadTrialPrincipal } from "./postgresql-trial-principal.ts";
import type { TenantTransaction, TenantTransactionRunner } from "../../shared/server.ts";
import type {
  AccessCaseIntakeOwnerPort,
  CaseIntakeOwnerAdvisorOption,
} from "../../shared/public.ts";

interface AdvisorRow extends Record<string, unknown> {
  id: string;
  role: "advisor" | "founder" | "l1" | "l2";
  membership_id?: string;
  user_id?: string;
  normalized_email?: string;
  display_name?: string | null;
}

export class PostgresqlAccessCaseIntakeOwner implements AccessCaseIntakeOwnerPort {
  private readonly runner: TenantTransactionRunner;

  constructor(runner: TenantTransactionRunner) {
    this.runner = runner;
  }

  listAdvisors(input: Readonly<{ organizationId: string; actorUserId: string; query: string | null; businessCategory?: K12BusinessCategory | null }>) {
    return this.runner.run(
      { organizationId: input.organizationId, actorUserId: input.actorUserId },
      async (transaction) => {
        const principal = await loadTrialPrincipal(asPrincipalTransaction(transaction), {
          organizationId: input.organizationId, userId: input.actorUserId, lock: true,
        });
        if (principal && !evaluateTrialAccess(principal, "case.create", {
          organizationId: input.organizationId, category: input.businessCategory,
        }).allowed) return Object.freeze([]);
        const result = await transaction.query<AdvisorRow>({
          text: `SELECT binding.id, binding.role, binding.user_id,
                        actor.normalized_email,
                        employee_profile.display_name
                   FROM access_role_bindings AS binding
                   JOIN access_organization_memberships AS membership
                     ON membership.id=binding.membership_id
                    AND membership.organization_id=binding.organization_id
                   JOIN identity_users AS actor ON actor.id=binding.user_id
                   LEFT JOIN access_employee_profiles AS employee_profile
                     ON employee_profile.membership_id=membership.id
                    AND employee_profile.organization_id=membership.organization_id
                  WHERE binding.organization_id=$1 AND (binding.role='advisor' OR
                    ($4::boolean AND EXISTS (SELECT 1 FROM access_trial_members t
                      WHERE t.organization_id=binding.organization_id AND t.user_id=binding.user_id
                        AND t.status='active' AND t.level=binding.role
                        AND (t.level IN ('founder','l1') OR (t.level='l2' AND $3::text=ANY(t.categories))))))
                    AND binding.status='active' AND membership.status='active'
                    AND actor.status='active'
                    AND ($2::text IS NULL OR binding.id::text ILIKE '%' || $2 || '%'
                      OR actor.normalized_email ILIKE '%' || $2 || '%'
                      OR COALESCE(employee_profile.display_name, '') ILIKE '%' || $2 || '%')
                  ORDER BY COALESCE(NULLIF(BTRIM(employee_profile.display_name), ''), ''),
                    actor.normalized_email, binding.id LIMIT 20`,
          values: [input.organizationId, input.query, input.businessCategory ?? null, principal !== null],
        });
        return Object.freeze(result.rows.map((row): CaseIntakeOwnerAdvisorOption => Object.freeze({
          id: row.id,
          role: row.role,
          displayName: advisorDisplayName(row),
        })));
      },
    );
  }

  async lockAdvisor(
    transaction: TenantTransaction,
    input: Readonly<{ organizationId: string; roleBindingId: string; businessCategory?: K12BusinessCategory | null }>,
  ) {
    const result = await transaction.query<AdvisorRow>({
      text: `SELECT binding.id, binding.membership_id, binding.user_id, binding.role
               FROM access_role_bindings AS binding
               JOIN access_organization_memberships AS membership
                 ON membership.id=binding.membership_id
                AND membership.organization_id=binding.organization_id
               JOIN identity_users AS actor ON actor.id=binding.user_id
              WHERE binding.organization_id=$1 AND binding.id=$2
                AND binding.role IN ('advisor','founder','l1','l2') AND binding.status='active'
                AND membership.status='active' AND actor.status='active'
              FOR SHARE OF binding, membership, actor`,
      values: [input.organizationId, input.roleBindingId],
    });
    const row = result.rows[0];
    if (row?.user_id) {
      const principal = await loadTrialPrincipal(asPrincipalTransaction(transaction), {
        organizationId: input.organizationId, userId: row.user_id, lock: true,
      });
      if (principal ? principal.level !== row.role || !evaluateTrialAccess(principal, "case.manage", {
        organizationId: input.organizationId, category: input.businessCategory,
      }).allowed : row.role !== "advisor") return null;
    }
    return row && row.membership_id && row.user_id
      ? Object.freeze({ id: row.id, membershipId: row.membership_id, userId: row.user_id, role: row.role })
      : null;
  }

  async assertCurrentAdvisor(
    transaction: TenantTransaction,
    input: Readonly<{ organizationId: string; actorUserId: string; actorRole?: string; businessCategory?: K12BusinessCategory | null }>,
  ): Promise<boolean> {
    const principal = await loadTrialPrincipal(asPrincipalTransaction(transaction), {
      organizationId: input.organizationId, userId: input.actorUserId, lock: true,
    });
    if (principal) return (!input.actorRole || input.actorRole === principal.level)
      && evaluateTrialAccess(principal, "case.create", {
        organizationId: input.organizationId, category: input.businessCategory,
      }).allowed;
    if (input.actorRole && input.actorRole !== "advisor") return false;
    const result = await transaction.query<{ id: string }>({
      text: `SELECT binding.id
               FROM identity_users AS actor
               JOIN access_organization_memberships AS membership
                 ON membership.user_id=actor.id AND membership.organization_id=$1
                AND membership.status='active'
               JOIN access_role_bindings AS binding
                 ON binding.membership_id=membership.id
                AND binding.organization_id=membership.organization_id
                AND binding.user_id=actor.id AND binding.role='advisor'
                AND binding.status='active'
               JOIN access_organizations AS organization
                 ON organization.id=membership.organization_id AND organization.status='active'
              WHERE actor.id=$2 AND actor.status='active'
              FOR SHARE OF actor,membership,binding,organization`,
      values: [input.organizationId, input.actorUserId],
    });
    return result.rows.length > 0;
  }
}

function advisorDisplayName(row: AdvisorRow): string {
  const nickname = row.display_name?.trim() || "未设置昵称";
  const email = row.normalized_email?.trim() || "未提供邮箱";
  return `${nickname} · ${email}`;
}

function asPrincipalTransaction(transaction: TenantTransaction) {
  return { query: <Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) =>
    transaction.query<Row>({ text, values }) };
}
