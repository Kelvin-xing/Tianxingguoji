import "server-only";

import type { TenantTransaction } from "../../shared/server.ts";
import type { SchoolsPortalReadPort } from "../application/portal-read-port.ts";

export class PostgreSqlSchoolsPortalReadAdapter implements SchoolsPortalReadPort {
  async readLabels(transaction: TenantTransaction, input: { organizationId: string; schoolIds: readonly string[] }): Promise<ReadonlyMap<string, string>> {
    if (input.schoolIds.length === 0) return new Map();
    const result = await transaction.query<{ id: string; label: string }>({
      text: `SELECT school.id, COALESCE(NULLIF(btrim(school.display_name),''), school.id::text) AS label
        FROM schools_schools AS school WHERE school.organization_id=$1 AND school.id=ANY($2::uuid[])`,
      values: [input.organizationId, input.schoolIds],
    });
    return new Map(result.rows.map((row) => [row.id, row.label]));
  }
}
