import "server-only";

import type {
  CaseDashboardProjectionRepository,
  CaseDashboardProjectionRepositoryInput,
  CaseDashboardProjectionTransactionResult,
  CaseDashboardProjectionSource,
} from "../domain/case-dashboard-projection.ts";
import { buildCaseDashboardProjection } from "../domain/case-dashboard-projection.ts";
import type { TenantTransaction, TenantTransactionRunner } from "../../shared/server.ts";

interface RoleRow extends Record<string, unknown> {
  role: string;
}

interface DashboardCaseRow extends Record<string, unknown> {
  case_id: string;
  organization_id: string;
  case_number: string;
  student_display_name: string;
  stage: string;
  blocker_count: number | string;
  next_action: string | null;
  next_action_due_at_ms: number | string | null;
  education_profile_completeness: number | string;
  school_target_count: number | string;
  open_task_count: number | string;
  unread_communication_count: number | string;
}

interface CapturedAtRow extends Record<string, unknown> {
  captured_at_ms: number | string;
}

/**
 * Local/test read adapter for the existing Case dashboard contract.
 * Authorization facts are read again inside the tenant transaction; the
 * projection itself never grants access.
 */
export class PostgresqlCaseDashboardProjectionRepository
  implements CaseDashboardProjectionRepository {
  private readonly runner: TenantTransactionRunner;

  constructor(runner: TenantTransactionRunner) {
    this.runner = runner;
  }

  async readDashboardTransaction(
    input: CaseDashboardProjectionRepositoryInput,
  ): Promise<CaseDashboardProjectionTransactionResult> {
    return this.runner.run(
      { organizationId: input.organizationId, actorUserId: input.actorUserId },
      async (transaction) => this.readWithinTenant(transaction, input),
    );
  }

  private async readWithinTenant(
    transaction: TenantTransaction,
    input: CaseDashboardProjectionRepositoryInput,
  ): Promise<CaseDashboardProjectionTransactionResult> {
    const roleResult = await transaction.query<RoleRow>({
      text: `SELECT binding.role
        FROM identity_users AS actor
        JOIN access_organization_memberships AS membership
          ON membership.user_id = actor.id
         AND membership.organization_id = $2
         AND membership.status = 'active'
        JOIN access_organizations AS organization
          ON organization.id = membership.organization_id
         AND organization.status = 'active'
        JOIN access_role_bindings AS binding
          ON binding.membership_id = membership.id
         AND binding.organization_id = membership.organization_id
         AND binding.user_id = actor.id
         AND binding.status = 'active'
       WHERE actor.id = $1
         AND actor.status = 'active'
       FOR SHARE OF actor, membership, organization, binding`,
      values: [input.actorUserId, input.organizationId],
    });
    const roles = new Set(roleResult.rows.map((row) => row.role));

    let authority: CaseDashboardProjectionTransactionResult["authority"];
    if (roles.has("founder")) {
      authority = { kind: "founder" };
    } else if (roles.has("advisor")) {
      const assignments = await transaction.query<{ service_case_id: string }>({
        text: `SELECT assignment.service_case_id
          FROM cases_primary_advisor_assignments AS assignment
         WHERE assignment.organization_id = $2
           AND assignment.advisor_user_id = $1
           AND assignment.starts_at <= to_timestamp($3::double precision / 1000)
           AND (assignment.ends_at IS NULL OR assignment.ends_at > to_timestamp($3::double precision / 1000))
         ORDER BY assignment.service_case_id`,
        values: [input.actorUserId, input.organizationId, input.nowMs],
      });
      authority = {
        kind: "advisor",
        assignedCaseIds: Object.freeze(assignments.rows.map((row) => row.service_case_id)),
      };
    } else {
      authority = { kind: "denied" };
    }

    const cases = await transaction.query<DashboardCaseRow>({
      text: `SELECT service_case.id AS case_id,
          service_case.organization_id,
          service_case.case_number,
          student.display_name AS student_display_name,
          service_case.stage,
          COALESCE((
            SELECT count(*)::int
              FROM cases_schema_manifest_fields AS field
              LEFT JOIN LATERAL (
                SELECT answer.semantic_state
                  FROM cases_assessment_answers AS answer
                 WHERE answer.assessment_id = assessment.id
                   AND answer.organization_id = assessment.organization_id
                   AND answer.manifest_id = assessment.manifest_id
                   AND answer.field_id = field.field_id
                 ORDER BY answer.revision_number DESC
                 LIMIT 1
              ) AS current_answer ON true
             WHERE assessment.id IS NOT NULL
               AND field.manifest_id = assessment.manifest_id
               AND field.blocking_stages ? CASE service_case.stage
                 WHEN 'background_collection' THEN 'background_complete'
                 WHEN 'school_selection_confirmed' THEN 'selection_ready'
                 ELSE NULL
               END
               AND (current_answer.semantic_state IS NULL OR current_answer.semantic_state <> 'provided')
          ), 0) AS blocker_count,
          NULL::text AS next_action,
          NULL::bigint AS next_action_due_at_ms,
          COALESCE((
            SELECT round(
              100.0 * count(*) FILTER (WHERE current_answer.semantic_state = 'provided')
              / NULLIF(count(*), 0)
            )::int
              FROM cases_schema_manifest_fields AS field
              LEFT JOIN LATERAL (
                SELECT answer.semantic_state
                  FROM cases_assessment_answers AS answer
                 WHERE answer.assessment_id = assessment.id
                   AND answer.organization_id = assessment.organization_id
                   AND answer.manifest_id = assessment.manifest_id
                   AND answer.field_id = field.field_id
                 ORDER BY answer.revision_number DESC
                 LIMIT 1
              ) AS current_answer ON true
             WHERE assessment.id IS NOT NULL
               AND field.manifest_id = assessment.manifest_id
          ), 0) AS education_profile_completeness,
          (
            SELECT count(*)::int
              FROM cases_school_targets AS target
             WHERE target.organization_id = service_case.organization_id
               AND target.service_case_id = service_case.id
          ) AS school_target_count,
          (
            SELECT count(*)::int
              FROM tasks_tasks AS task
             WHERE task.organization_id = service_case.organization_id
               AND task.service_case_id = service_case.id
               AND task.state NOT IN ('completed', 'cancelled', 'rejected')
          ) AS open_task_count,
          (
            SELECT count(*)::int
              FROM notifications_notifications AS notification
             WHERE notification.organization_id = service_case.organization_id
               AND notification.recipient_user_id = $1
               AND notification.target_kind = 'case'
               AND notification.target_opaque_id = service_case.id::text
               AND notification.status = 'unread'
          ) AS unread_communication_count
        FROM cases_service_cases AS service_case
        JOIN crm_students AS student
          ON student.id = service_case.student_id
         AND student.organization_id = service_case.organization_id
         AND student.status = 'active'
        LEFT JOIN LATERAL (
          SELECT assessment.id, assessment.organization_id, assessment.manifest_id
            FROM cases_assessments AS assessment
           WHERE assessment.organization_id = service_case.organization_id
             AND assessment.service_case_id = service_case.id
           ORDER BY assessment.updated_at DESC, assessment.id DESC
           LIMIT 1
        ) AS assessment ON true
       WHERE service_case.organization_id = $2
       ORDER BY service_case.id`,
      values: [input.actorUserId, input.organizationId],
    });

    const capturedAt = await transaction.query<CapturedAtRow>({
      text: `SELECT extract(epoch FROM coalesce(max(updated_at), transaction_timestamp())) * 1000 AS captured_at_ms
        FROM cases_service_cases
       WHERE organization_id = $1`,
      values: [input.organizationId],
    });

    const source: CaseDashboardProjectionSource = {
      schemaVersion: "case_dashboard_source_v1",
      sourceSnapshotId: `live-${input.organizationId}`,
      sourceCapturedAtMs: toSafeInteger(capturedAt.rows[0]?.captured_at_ms, input.nowMs),
      organizationId: input.organizationId,
      cases: Object.freeze(cases.rows.map((row) => ({
        caseId: row.case_id,
        organizationId: row.organization_id,
        caseNumber: row.case_number,
        studentDisplayName: row.student_display_name,
        stage: row.stage as CaseDashboardProjectionSource["cases"][number]["stage"],
        blockerCount: toSafeInteger(row.blocker_count, 0),
        nextAction: row.next_action,
        nextActionDueAtMs: row.next_action_due_at_ms === null
          ? null
          : toSafeInteger(row.next_action_due_at_ms, 0),
        educationProfileCompleteness: toSafeInteger(row.education_profile_completeness, 0),
        schoolTargetCount: toSafeInteger(row.school_target_count, 0),
        openTaskCount: toSafeInteger(row.open_task_count, 0),
        unreadCommunicationCount: toSafeInteger(row.unread_communication_count, 0),
      }))),
    };

    return Object.freeze({
      projection: buildCaseDashboardProjection(source),
      authority,
      stale: false,
    });
  }
}

function toSafeInteger(value: unknown, fallback: number): number {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(numeric) ? numeric : fallback;
}
