import "server-only";

import type { AccessAuthorizationRepository } from "../application/authorization-service.ts";
import type { AccessResolutionFacts } from "../domain/authorization.ts";
import type { Release1OrganizationRole } from "../domain/contract.ts";

export interface AccessAuthorizationDatabaseClient {
  query<Row = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[] }>;
}

interface AccessRoleRow {
  user_id: string;
  organization_id: string;
  membership_id: string;
  membership_record_version: string | number;
  role_binding_id: string;
  role: Release1OrganizationRole;
  role_binding_record_version: string | number;
}

/** Request-time Access resolver. It intentionally has no cache or session role input. */
export class PostgresqlAccessAuthorizationRepository implements AccessAuthorizationRepository {
  private readonly client: AccessAuthorizationDatabaseClient;

  constructor(client: AccessAuthorizationDatabaseClient) {
    this.client = client;
  }

  async resolveAccessFacts(input: Readonly<{
    readonly userId: string;
    readonly organizationId: string;
    readonly membershipId: string;
  }>): Promise<AccessResolutionFacts | null> {
    const result = await this.client.query<AccessRoleRow>(
      "SELECT * FROM access_resolve_workspace_context($1, $2, $3)",
      [input.userId, input.organizationId, input.membershipId],
    );
    if (result.rows.length === 0) return null;
    const first = result.rows[0]!;
    return Object.freeze({
      userId: first.user_id,
      organizationId: first.organization_id,
      membershipId: first.membership_id,
      roles: Object.freeze(result.rows.map(({ role }) => role)),
      membershipRecordVersion: positiveInteger(first.membership_record_version),
      roleBindingRecordVersions: Object.freeze(
        result.rows.map(({ role_binding_record_version }) => positiveInteger(role_binding_record_version)),
      ),
    });
  }
}

function positiveInteger(value: string | number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error("Invalid authorization record version.");
  return parsed;
}
