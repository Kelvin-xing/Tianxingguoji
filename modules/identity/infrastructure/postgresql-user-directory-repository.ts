import "server-only";

import type {
  UserDirectoryEntry,
  UserDirectoryRepository,
  UserDirectoryRole,
} from "../application/user-directory.ts";
import type { MembershipStatus, UserStatus } from "../domain/contract.ts";
import type { EmploymentType, OrganizationRole, RoleBindingStatus } from "../../access/public.ts";
import { buildMemberAccessVersion } from "../../access/public.ts";
import type { TenantTransactionRunner } from "../../shared/server.ts";

interface UserDirectoryRow {
  user_id: string;
  normalized_email: string;
  user_status: UserStatus;
  membership_status: MembershipStatus;
  membership_record_version: number | string;
  display_name: string | null;
  employment_type: EmploymentType | null;
  profile_record_version: number | string | null;
  role_binding_id: string | null;
  role_record_version: number | string | null;
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
                   membership.record_version AS membership_record_version,
                   employee_profile.display_name,
                   employee_profile.employment_type,
                   employee_profile.record_version AS profile_record_version,
                   role_binding.id AS role_binding_id,
                   role_binding.record_version AS role_record_version,
                   role_binding.role,
                   role_binding.status AS role_status,
                   GREATEST(identity_user.updated_at, membership.updated_at,
                     COALESCE(employee_profile.updated_at, identity_user.updated_at),
                     COALESCE(role_binding.updated_at, identity_user.updated_at)) AS updated_at
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
                  AND role_binding.status = 'active'
                  AND role_binding.role IN ('founder','admin','advisor','contractor')
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
    readonly membershipRecordVersion: number;
    readonly displayName: string | null;
    readonly employmentType: EmploymentType | null;
    readonly profileRecordVersion: number | null;
    readonly roles: UserDirectoryRole[];
    readonly roleVersions: { readonly bindingId: string; readonly recordVersion: number }[];
    updatedAt: string;
  }>();

  for (const row of rows) {
    const updatedAt = toIsoString(row.updated_at);
    const existing = users.get(row.user_id);
    if (existing) {
      if (row.role !== null && row.role_status !== null) {
        existing.roles.push({ role: row.role, status: row.role_status });
        if (row.role_binding_id !== null && row.role_record_version !== null) {
          existing.roleVersions.push({
            bindingId: row.role_binding_id,
            recordVersion: positiveInteger(row.role_record_version),
          });
        }
      }
      if (updatedAt > existing.updatedAt) existing.updatedAt = updatedAt;
      continue;
    }
    users.set(row.user_id, {
      userId: row.user_id,
      normalizedEmail: row.normalized_email,
      userStatus: row.user_status,
      membershipStatus: row.membership_status,
      membershipRecordVersion: positiveInteger(row.membership_record_version),
      displayName: row.display_name,
      employmentType: row.employment_type,
      profileRecordVersion: row.profile_record_version === null
        ? null
        : positiveInteger(row.profile_record_version),
      roles: row.role !== null && row.role_status !== null
        ? [{ role: row.role, status: row.role_status }]
        : [],
      roleVersions: row.role_binding_id !== null && row.role_record_version !== null
        ? [{ bindingId: row.role_binding_id, recordVersion: positiveInteger(row.role_record_version) }]
        : [],
      updatedAt,
    });
  }

  return Object.freeze([...users.values()].map((user) => Object.freeze({
    userId: user.userId,
    normalizedEmail: user.normalizedEmail,
    userStatus: user.userStatus,
    membershipStatus: user.membershipStatus,
    displayName: user.displayName,
    employmentType: user.employmentType,
    profileRecordVersion: user.profileRecordVersion,
    accessVersion: buildMemberAccessVersion({
      membershipRecordVersion: user.membershipRecordVersion,
      profileRecordVersion: user.profileRecordVersion,
      roles: user.roleVersions,
    }),
    roles: Object.freeze(user.roles.map((role) => Object.freeze(role))),
    updatedAt: user.updatedAt,
  })));
}

function positiveInteger(value: number | string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new TypeError("User directory version is invalid.");
  }
  return parsed;
}

function toIsoString(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("User directory timestamp is invalid.");
  return date.toISOString();
}
