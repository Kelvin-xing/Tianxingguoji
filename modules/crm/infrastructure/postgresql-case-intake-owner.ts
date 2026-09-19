import "server-only";

import { evaluateTrialAccess, type K12BusinessCategory } from "../../access/public.ts";
import { loadTrialPrincipal } from "../../access/server.ts";
import type { TenantTransaction, TenantTransactionRunner } from "../../shared/server.ts";
import type { CaseIntakeOwnerOption, CrmCaseIntakeOwnerPort } from "../../shared/public.ts";

interface StudentRow extends Record<string, unknown> {
  id: string;
  display_name: string;
}

interface SourceRow extends Record<string, unknown> {
  id: string;
  display_name: string;
  source_type: string;
  record_version: number | string;
}

export class PostgresqlCrmCaseIntakeOwner implements CrmCaseIntakeOwnerPort {
  private readonly runner: TenantTransactionRunner;

  constructor(runner: TenantTransactionRunner) {
    this.runner = runner;
  }

  listStudents(input: Readonly<{ organizationId: string; actorUserId: string; query: string | null; businessCategory?: K12BusinessCategory | null }>) {
    return this.runner.run(
      { organizationId: input.organizationId, actorUserId: input.actorUserId },
      async (transaction) => {
        const scope = await intakeScope(transaction, input);
        if (!scope.allowed) return Object.freeze([]);
        const result = await transaction.query<StudentRow>({
          text: `SELECT student.id, student.display_name FROM crm_students student
                  WHERE organization_id=$1 AND status='active'
                    AND ($3::text[] IS NULL OR EXISTS (SELECT 1 FROM cases_service_cases c
                      WHERE c.organization_id=student.organization_id AND c.student_id=student.id
                        AND c.business_category=ANY($3::text[])))
                    AND ($2::text IS NULL OR display_name ILIKE '%' || $2 || '%')
                  ORDER BY display_name COLLATE "C", id LIMIT 20`,
          values: [input.organizationId, input.query, scope.categories],
        });
        return Object.freeze(result.rows.map((row): CaseIntakeOwnerOption => Object.freeze({
          id: row.id,
          displayName: row.display_name,
        })));
      },
    );
  }

  listReferralSources(input: Readonly<{ organizationId: string; actorUserId: string; query: string | null; businessCategory?: K12BusinessCategory | null }>) {
    return this.runner.run(
      { organizationId: input.organizationId, actorUserId: input.actorUserId },
      async (transaction) => {
        const scope = await intakeScope(transaction, input);
        if (!scope.allowed) return Object.freeze([]);
        const result = await transaction.query<SourceRow>({
          text: `SELECT source.id, source.display_name FROM crm_referral_sources source
                  WHERE organization_id=$1 AND status='active'
                    AND ($3::text[] IS NULL OR EXISTS (SELECT 1 FROM cases_case_referral_source_assignments a
                      JOIN cases_service_cases c ON c.id=a.case_id AND c.organization_id=a.organization_id
                      WHERE a.organization_id=source.organization_id AND a.referral_source_id=source.id
                        AND c.business_category=ANY($3::text[])))
                    AND ($2::text IS NULL OR display_name ILIKE '%' || $2 || '%')
                  ORDER BY display_name COLLATE "C", id LIMIT 20`,
          values: [input.organizationId, input.query, scope.categories],
        });
        return Object.freeze(result.rows.map((row): CaseIntakeOwnerOption => Object.freeze({
          id: row.id,
          displayName: row.display_name,
        })));
      },
    );
  }

  async lockStudent(
    transaction: TenantTransaction,
    input: Readonly<{ organizationId: string; studentId: string; actorUserId?: string; businessCategory?: K12BusinessCategory | null }>,
  ): Promise<boolean> {
    const scope = await intakeScope(transaction,input);
    if (!scope.allowed) return false;
    const result = await transaction.query<{ id: string }>({
      text: `SELECT student.id FROM crm_students student
              WHERE organization_id=$1 AND id=$2 AND status='active'
                AND ($3::text[] IS NULL OR EXISTS (SELECT 1 FROM cases_service_cases c
                  WHERE c.organization_id=student.organization_id AND c.student_id=student.id
                    AND c.business_category=ANY($3::text[]))) FOR SHARE OF student`,
      values: [input.organizationId, input.studentId, scope.categories],
    });
    return result.rows.length === 1;
  }

  async lockReferralSource(
    transaction: TenantTransaction,
    input: Readonly<{ organizationId: string; sourceId: string; actorUserId?: string; businessCategory?: K12BusinessCategory | null }>,
  ) {
    const scope = await intakeScope(transaction,input);
    if (!scope.allowed) return null;
    const result = await transaction.query<SourceRow>({
      text: `SELECT id, display_name, source_type, record_version
               FROM crm_referral_sources source
              WHERE organization_id=$1 AND id=$2 AND status='active'
                AND ($3::text[] IS NULL OR EXISTS (SELECT 1 FROM cases_case_referral_source_assignments a
                  JOIN cases_service_cases c ON c.id=a.case_id AND c.organization_id=a.organization_id
                  WHERE a.organization_id=source.organization_id AND a.referral_source_id=source.id
                    AND c.business_category=ANY($3::text[]))) FOR SHARE OF source`,
      values: [input.organizationId, input.sourceId, scope.categories],
    });
    const row = result.rows[0];
    return row ? Object.freeze({
      id: row.id,
      displayName: row.display_name,
      sourceType: row.source_type,
      recordVersion: Number(row.record_version),
    }) : null;
  }
}

async function intakeScope(transaction: TenantTransaction, input: Readonly<{
  organizationId: string; actorUserId?: string; businessCategory?: K12BusinessCategory | null;
}>): Promise<Readonly<{ allowed: boolean; categories: readonly K12BusinessCategory[] | null }>> {
  const actorId = input.actorUserId ?? (await transaction.query<{ id: string }>({
    text: "SELECT nullif(current_setting('app.actor_user_id',true),'') AS id",
  })).rows[0]?.id;
  if (!actorId) return { allowed: false, categories: [] };
  const principal = await loadTrialPrincipal({
    query: <Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) =>
      transaction.query<Row>({ text, values }),
  }, { userId: actorId, organizationId: input.organizationId, lock: true });
  if (!principal) return { allowed: true, categories: null };
  return { allowed: evaluateTrialAccess(principal, "case.create", {
    organizationId: input.organizationId, category: input.businessCategory,
  }).allowed, categories: principal.level === "l2" ? principal.categories : null };
}
