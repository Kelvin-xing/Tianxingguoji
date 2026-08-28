import "server-only";

import type {
  UserDirectoryEntry,
  UserDirectoryRepository,
  UserDirectoryRole,
} from "../application/user-directory.ts";
import type { MembershipStatus, UserStatus } from "../domain/contract.ts";
import type { EmploymentType, OrganizationRole, RoleBindingStatus } from "../../access/public.ts";
import type { TenantTransactionRunner } from "../../shared/server.ts";

interface UserDirectoryRow {
  user_id: string;
  normalized_email: string;
  user_status: UserStatus;
  membership_status: MembershipStatus;
  display_name: string | null;
  employment_type: EmploymentType | null;
  role: OrganizationRole | null;
  role_status: RoleBindingStatus | null;
  updated_at: Date | string;
}

export class PostgresqlUserDirectoryRepository implements UserDirectoryRepository {
  private readonly runner: TenantTransactionRunner;

  constructor(runner: TenantTransactionRunner) {
    this.runner = runner;
  }

  listUsers(input: Parameters<UserDirectoryRepository["listUsers"]>[0]) {
    return this.runner.run(
      { organizationId: input.organizationId, actorUserId: input.actorUserId },
      async (transaction) => {
        const result = await transaction.query<UserDirectoryRow>({
          text: `SELECT
                   identity_user.id AS user_id,
                   identity_user.normalized_email,
                   identity_user.status AS user_status,
                   membership.status AS membership_status,
                   employee_profile.display_name,
                   employee_profile.employment_type,
                   role_binding.role,
                   role_binding.status AS role_status,
                   GREATEST(identity_user.updated_at, membership.updated_at,
                     COALESCE(employee_profile.updated_at, identity_user.updated_at)) AS updated_at
                 FROM identity_users AS identity_user
                 JOIN access_organization_memberships AS membership
                   ON membership.user_id = identity_user.id
                  AND membership.organization_id = $1
                 LEFT JOIN access_employee_profiles AS employee_profile
                   ON employee_profile.membership_id = membership.id
                  AND employee_profile.organization_id = membership.organization_id
                 LEFT JOIN access_role_bindings AS role_binding
                   ON role_binding.membership_id = membership.id
                  AND role_binding.organization_id = membership.organization_id
                  AND role_binding.user_id = identity_user.id
                 WHERE membership.organization_id = $1
                 ORDER BY COALESCE(employee_profile.display_name, ''),
                   identity_user.normalized_email, identity_user.id, role_binding.id`,
          values: [input.organizationId],
        });
        return aggregateUsers(result.rows);
      },
    );
  }
}

function aggregateUsers(rows: readonly UserDirectoryRow[]): readonly UserDirectoryEntry[] {
  const users = new Map<string, {
    readonly userId: string;
    readonly normalizedEmail: string;
    readonly userStatus: UserStatus;
    readonly membershipStatus: MembershipStatus;
    readonly displayName: string | null;
    readonly employmentType: EmploymentType | null;
    readonly roles: UserDirectoryRole[];
    updatedAt: string;
  }>();

  for (const row of rows) {
    const updatedAt = toIsoString(row.updated_at);
    const existing = users.get(row.user_id);
    if (existing) {
      if (row.role !== null && row.role_status !== null) {
        existing.roles.push({ role: row.role, status: row.role_status });
      }
      if (updatedAt > existing.updatedAt) existing.updatedAt = updatedAt;
      continue;
    }
    users.set(row.user_id, {
      userId: row.user_id,
      normalizedEmail: row.normalized_email,
      userStatus: row.user_status,
      membershipStatus: row.membership_status,
      displayName: row.display_name,
      employmentType: row.employment_type,
      roles: row.role !== null && row.role_status !== null
        ? [{ role: row.role, status: row.role_status }]
        : [],
      updatedAt,
    });
  }

  return Object.freeze([...users.values()].map((user) => Object.freeze({
    ...user,
    roles: Object.freeze(user.roles.map((role) => Object.freeze(role))),
  })));
}

function toIsoString(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("User directory timestamp is invalid.");
  return date.toISOString();
}
