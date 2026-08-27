import "server-only";

import type { TenantTransactionRunner } from "../../shared/server.ts";
import {
  CandidateGuardianContextError,
  type CandidateGuardianContextRepository,
} from "../application/candidate-guardian-context-service.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface ContextRow extends Record<string, unknown> {
  readonly case_id: string;
  readonly student_id: string;
}

export class PostgresqlCandidateGuardianContextRepository
implements CandidateGuardianContextRepository {
  private readonly runner: TenantTransactionRunner;

  constructor(runner: TenantTransactionRunner) {
    this.runner = runner;
  }

  find(input: Parameters<CandidateGuardianContextRepository["find"]>[0]) {
    return this.runner.run({
      organizationId: input.organizationId,
      actorKind: "user",
      actorOpaqueId: input.actorUserId,
      actorUserId: input.actorUserId,
      requestId: `candidate-guardian-context-${input.caseId}`,
    }, async (transaction) => {
      try {
        const result = await transaction.query<ContextRow>({
          text: `SELECT service_case.id AS case_id,service_case.student_id
                   FROM cases_service_cases AS service_case
                  WHERE service_case.organization_id=$1 AND service_case.id=$2
                    AND cases_actor_has_active_case_role(service_case.id,'advisor',true)`,
          values: [input.organizationId,input.caseId],
        });
        const row = result.rows[0];
        if (!row) return null;
        const caseId = row.case_id?.toLowerCase();
        const studentId = row.student_id?.toLowerCase();
        if (!UUID.test(caseId) || !UUID.test(studentId)) {
          throw new CandidateGuardianContextError("CANDIDATE_GUARDIAN_CONTEXT_UNAVAILABLE");
        }
        return Object.freeze({ caseId,studentId });
      } catch (error) {
        if (error instanceof CandidateGuardianContextError) throw error;
        throw new CandidateGuardianContextError("CANDIDATE_GUARDIAN_CONTEXT_UNAVAILABLE");
      }
    });
  }
}
