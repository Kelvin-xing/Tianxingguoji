import "server-only";

import type { TenantTransaction } from "../../shared/server.ts";
import type {
  CustomerDeletionGuardPort,
  CustomerDeletionGuardResult,
} from "../application/customer-deletion-guard.ts";

interface CaseGuardRow extends Record<string, unknown> {
  stage: string;
  primary_user_id: string;
  primary_role: string;
}

export class PostgresqlCustomerDeletionGuard implements CustomerDeletionGuardPort {
  async evaluateStudentDeletion(input: {
    readonly transaction: TenantTransaction;
    readonly studentId: string;
    readonly actorUserId: string;
    readonly actorRole: string;
  }): Promise<CustomerDeletionGuardResult> {
    const result = await input.transaction.query<CaseGuardRow>({
      text: `SELECT stage,primary_user_id,primary_role
               FROM cases_service_cases
              WHERE organization_id = current_setting('app.organization_id', true)::uuid
                AND student_id=$1
              ORDER BY id
              FOR SHARE`,
      values: [input.studentId],
    });
    return Object.freeze({
      hasOpenCase: result.rows.some(({ stage }) => stage !== "closed"),
      actorScoped: input.actorRole === "founder" || result.rows.some((row) =>
        input.actorRole === "advisor" && row.primary_role === "advisor" &&
        row.primary_user_id === input.actorUserId),
    });
  }
}
