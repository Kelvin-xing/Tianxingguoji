import "server-only";

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

  listStudents(input: Readonly<{ organizationId: string; actorUserId: string; query: string | null }>) {
    return this.runner.run(
      { organizationId: input.organizationId, actorUserId: input.actorUserId },
      async (transaction) => {
        const result = await transaction.query<StudentRow>({
          text: `SELECT id, display_name FROM crm_students
                  WHERE organization_id=$1 AND status='active'
                    AND ($2::text IS NULL OR display_name ILIKE '%' || $2 || '%')
                  ORDER BY display_name COLLATE "C", id LIMIT 20`,
          values: [input.organizationId, input.query],
        });
        return Object.freeze(result.rows.map((row): CaseIntakeOwnerOption => Object.freeze({
          id: row.id,
          displayName: row.display_name,
        })));
      },
    );
  }

  listReferralSources(input: Readonly<{ organizationId: string; actorUserId: string; query: string | null }>) {
    return this.runner.run(
      { organizationId: input.organizationId, actorUserId: input.actorUserId },
      async (transaction) => {
        const result = await transaction.query<SourceRow>({
          text: `SELECT id, display_name FROM crm_referral_sources
                  WHERE organization_id=$1 AND status='active'
                    AND ($2::text IS NULL OR display_name ILIKE '%' || $2 || '%')
                  ORDER BY display_name COLLATE "C", id LIMIT 20`,
          values: [input.organizationId, input.query],
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
    input: Readonly<{ organizationId: string; studentId: string }>,
  ): Promise<boolean> {
    const result = await transaction.query<{ id: string }>({
      text: `SELECT id FROM crm_students
              WHERE organization_id=$1 AND id=$2 AND status='active' FOR SHARE`,
      values: [input.organizationId, input.studentId],
    });
    return result.rows.length === 1;
  }

  async lockReferralSource(
    transaction: TenantTransaction,
    input: Readonly<{ organizationId: string; sourceId: string }>,
  ) {
    const result = await transaction.query<SourceRow>({
      text: `SELECT id, display_name, source_type, record_version
               FROM crm_referral_sources
              WHERE organization_id=$1 AND id=$2 AND status='active' FOR SHARE`,
      values: [input.organizationId, input.sourceId],
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
