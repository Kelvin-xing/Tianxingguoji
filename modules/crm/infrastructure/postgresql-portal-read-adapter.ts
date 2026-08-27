import "server-only";

import type { TenantTransaction } from "../../shared/server.ts";
import type { CrmPortalReadPort, CrmPortalRelationshipFacts } from "../application/portal-read-port.ts";

export class PostgreSqlCrmPortalReadAdapter implements CrmPortalReadPort {
  async readGuardianRelationship(transaction: TenantTransaction, input: { organizationId: string; relationshipId: string; studentId: string }): Promise<CrmPortalRelationshipFacts | null> {
    const result = await transaction.query<CrmPortalRelationshipFacts>({
      text: `SELECT (relationship.ends_at IS NULL AND student.status='active' AND guardian.status='active') AS active,
        relationship.student_id AS "studentId"
        FROM crm_student_guardian_relationships AS relationship
        JOIN crm_students AS student ON student.id=relationship.student_id AND student.organization_id=relationship.organization_id
        JOIN crm_guardians AS guardian ON guardian.id=relationship.guardian_id AND guardian.organization_id=relationship.organization_id
        WHERE relationship.id=$1 AND relationship.organization_id=$2 AND relationship.student_id=$3`,
      values: [input.relationshipId, input.organizationId, input.studentId],
    });
    return result.rows[0] ?? null;
  }
}
