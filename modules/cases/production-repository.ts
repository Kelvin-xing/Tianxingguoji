import "server-only";

import { appendAtomicMutationEffects } from "../audit/production-repository.ts";
import { insertActiveStudent } from "../crm/student-persistence.ts";
import type { CaseCreationRepository, CaseCreationResult } from "./service.ts";
import {
  requirePostgreSqlAdapter,
  type PostgreSqlAdapter,
} from "./postgresql.ts";

export class PostgreSqlCaseCreationRepository implements CaseCreationRepository {
  private readonly database: PostgreSqlAdapter;

  constructor(database: PostgreSqlAdapter) {
    this.database = database;
  }

  async createStudentAndK12Case(
    input: Parameters<CaseCreationRepository["createStudentAndK12Case"]>[0],
  ): Promise<CaseCreationResult> {
    return this.database.transaction({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
    }, async (tx) => {
      const claim = await tx.query(
        `INSERT INTO shared_idempotency_records
          (id, organization_id, actor_user_id, operation, idempotency_key, request_hash,
           state, created_at, updated_at)
         VALUES (gen_random_uuid(),$1,$2,'cases.create',$3,$4,'in_progress',
           to_timestamp($5 / 1000.0),to_timestamp($5 / 1000.0))
         ON CONFLICT (organization_id, actor_user_id, operation, idempotency_key) DO NOTHING
         RETURNING id`,
        [input.organizationId, input.actorUserId, input.idempotencyKey, input.requestHash,
          input.createdAtMs],
      );
      const replay = await tx.query<{ request_hash: string; state: string; result_reference: string | null }>(
        `SELECT request_hash, state, result_reference FROM shared_idempotency_records
         WHERE organization_id = $1 AND actor_user_id = $2 AND operation = 'cases.create'
           AND idempotency_key = $3 FOR UPDATE`,
        [input.organizationId, input.actorUserId, input.idempotencyKey],
      );
      if (claim.rowCount === 0) {
        const receipt = replay.rows[0];
        if (!receipt) throw new Error("CASE_CREATION_IDEMPOTENCY_IN_PROGRESS");
        if (receipt.request_hash !== input.requestHash) {
          throw new Error("CASE_CREATION_IDEMPOTENCY_KEY_REUSED");
        }
        if (receipt.state !== "completed" || receipt.result_reference === null) {
          throw new Error("CASE_CREATION_IDEMPOTENCY_IN_PROGRESS");
        }
        const stored = await tx.query<CaseCreationResult & Record<string, unknown>>(
          `SELECT sc.student_id AS "studentId", sc.id AS "serviceCaseId",
             a.id AS "assessmentId", sc.primary_user_id AS "primaryAdvisorUserId",
             sc.stage, sc.record_version::int AS "recordVersion"
           FROM cases_service_cases sc JOIN cases_assessments a
             ON a.service_case_id = sc.id AND a.organization_id = sc.organization_id
          WHERE sc.organization_id = $1 AND sc.id = $2`,
          [input.organizationId, receipt.result_reference],
        );
        if (stored.rowCount !== 1) throw new Error("CASE_CREATION_IDEMPOTENCY_IN_PROGRESS");
        return Object.freeze(stored.rows[0]);
      }

      const advisor = await tx.query<{
        role_binding_id: string;
        membership_id: string;
        user_id: string;
      }>(
        `SELECT rb.id AS role_binding_id, rb.membership_id, rb.user_id
         FROM access_role_bindings rb
         JOIN access_organization_memberships m
           ON m.id = rb.membership_id AND m.organization_id = rb.organization_id
         WHERE rb.organization_id = $1 AND rb.user_id = $2 AND rb.role = 'advisor'
           AND rb.status = 'active' AND m.status = 'active'
           AND identity_user_is_active(rb.user_id)
           AND access_organization_is_active(rb.organization_id)
         FOR UPDATE OF rb, m`,
        [input.organizationId, input.actorUserId],
      );
      if (advisor.rowCount !== 1) throw new Error("CASE_CREATION_PRIMARY_BINDING_INACTIVE");
      const manifest = await tx.query(
        `SELECT $1::uuid AS id WHERE cases_manifest_is_approved($1::uuid)`,
        [input.schemaManifestId],
      );
      if (manifest.rowCount !== 1) throw new Error("CASE_CREATION_MANIFEST_NOT_APPROVED");

      await insertActiveStudent(tx, {
        organizationId: input.organizationId,
        student: input.student,
      });
      const binding = advisor.rows[0];
      await tx.query(
        `INSERT INTO cases_service_cases
          (id, organization_id, student_id, case_number, application_type, intake_year,
           admission_type, primary_role_binding_id, primary_membership_id, primary_user_id,
           primary_role, stage)
         VALUES ($1,$2,$3,$4,'k12',$5,$6,$7,$8,$9,'advisor','signed')`,
        [input.serviceCaseId, input.organizationId, input.student.studentId, input.caseNumber,
          input.intakeYear, input.admissionType, binding.role_binding_id, binding.membership_id,
          binding.user_id],
      );
      await tx.query(
        `INSERT INTO cases_assessments
          (id, organization_id, service_case_id, manifest_id, status)
         VALUES ($1,$2,$3,$4,'draft')`,
        [input.assessmentId, input.organizationId, input.serviceCaseId, input.schemaManifestId],
      );
      await appendAtomicMutationEffects(tx, input.effects);

      const result: CaseCreationResult = Object.freeze({
        studentId: input.student.studentId,
        serviceCaseId: input.serviceCaseId,
        assessmentId: input.assessmentId,
        primaryAdvisorUserId: binding.user_id,
        stage: "signed",
        recordVersion: 1,
      });
      await tx.query(
        `UPDATE shared_idempotency_records
            SET state = 'completed', result_reference = $5, response_hash = $4,
                record_version = record_version + 1,
                updated_at = to_timestamp($6 / 1000.0)
          WHERE organization_id = $1 AND actor_user_id = $2 AND operation = 'cases.create'
            AND idempotency_key = $3 AND request_hash = $4 AND state = 'in_progress'`,
        [input.organizationId, input.actorUserId, input.idempotencyKey, input.requestHash,
          input.serviceCaseId, input.createdAtMs],
      );
      return result;
    });
  }
}

export function createProductionCaseCreationRepository(
  adapter?: PostgreSqlAdapter | null,
): CaseCreationRepository {
  return new PostgreSqlCaseCreationRepository(requirePostgreSqlAdapter(adapter));
}
