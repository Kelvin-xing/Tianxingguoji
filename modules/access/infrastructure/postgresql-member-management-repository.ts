import "server-only";

import type { MutationEffectBundle } from "../../audit/public.ts";
import {
  appendAtomicMutationEffects,
  type AtomicMutationTransaction,
} from "../../audit/server.ts";
import {
  hashRequestPayload,
} from "../../shared/public.ts";
import {
  IdempotencyExecutionError,
  runIdempotentTransaction,
  type TenantTransaction,
  type TenantTransactionRunner,
} from "../../shared/server.ts";
import {
  MemberManagementError,
  type MemberManagementRepository,
  type MemberMutationReceipt,
  type OwnEmployeeProfile,
} from "../application/member-management.ts";
import {
  buildMemberAccessVersion,
  type EmploymentType,
  type Release1OrganizationRole,
} from "../domain/contract.ts";

interface MembershipRow {
  readonly membership_id: string;
  readonly membership_record_version: number | string;
  readonly normalized_email: string;
  readonly user_status: string;
  readonly membership_status: string;
  readonly fallback_updated_at: Date | string;
}

interface ProfileRow {
  readonly display_name: string;
  readonly employment_type: EmploymentType;
  readonly record_version: number | string;
  readonly updated_at: Date | string;
}

interface RoleRow {
  readonly id: string;
  readonly role: Release1OrganizationRole;
  readonly record_version: number | string;
}

interface LockedMemberState {
  readonly membership: MembershipRow;
  readonly profile: ProfileRow | null;
  readonly roles: readonly RoleRow[];
}

export class PostgresqlMemberManagementRepository implements MemberManagementRepository {
  private readonly runner: TenantTransactionRunner;

  constructor(runner: TenantTransactionRunner) {
    this.runner = runner;
  }

  async getOwnProfile(input: Parameters<MemberManagementRepository["getOwnProfile"]>[0]) {
    try {
      return await this.runner.run(
        { organizationId: input.organizationId, actorUserId: input.actorUserId },
        async (transaction) => {
          const state = await loadMemberState(transaction, input.organizationId, input.actorUserId, false);
          return toOwnProfile(state, input.actorUserId);
        },
      );
    } catch (error) {
      throw mapRepositoryError(error);
    }
  }

  async updateOwnDisplayName(
    input: Parameters<MemberManagementRepository["updateOwnDisplayName"]>[0],
  ): Promise<MemberMutationReceipt> {
    try {
      const result = await runIdempotentTransaction({
        runner: this.runner,
        context: {
          organizationId: input.organizationId,
          actorUserId: input.actorUserId,
          requestId: input.requestId,
        },
        claim: {
          id: input.idempotencyId,
          organizationId: input.organizationId,
          actorKind: "user",
          actorOpaqueId: input.actorUserId,
          operation: "access.update_own_display_name",
          key: input.idempotencyKey,
          requestHash: input.requestHash,
          createdAt: input.occurredAt,
        },
        revalidate: async (transaction) => {
          await requireActiveMembership(transaction, input.organizationId, input.actorUserId);
        },
        execute: async (transaction) => {
          const state = await loadMemberState(
            transaction,
            input.organizationId,
            input.actorUserId,
            true,
          );
          const currentVersion = state.profile === null
            ? null
            : positiveInteger(state.profile.record_version);
          if (currentVersion !== input.expectedProfileRecordVersion) {
            throw new MemberManagementError("STALE_VERSION");
          }
          if (state.profile === null) {
            const employmentType = inferEmploymentType(state.roles);
            await transaction.query({
              text: `INSERT INTO access_employee_profiles
                (membership_id,organization_id,display_name,employment_type,record_version)
               VALUES ($1,$2,$3,$4,1)`,
              values: [state.membership.membership_id, input.organizationId,
                input.displayName, employmentType],
            });
          } else {
            await transaction.query({
              text: `UPDATE access_employee_profiles
                        SET display_name=$3,record_version=record_version+1
                      WHERE membership_id=$1 AND organization_id=$2`,
              values: [state.membership.membership_id, input.organizationId, input.displayName],
            });
          }
          await appendEffects(transaction, input.effects);
          const receipt = receiptValue(input.actorUserId, input.effects.audit.id, false);
          return {
            state: "completed" as const,
            resultReference: input.effects.audit.id,
            responseHash: hashRequestPayload({
              receipt_id: receipt.receiptId,
              replayed: receipt.replayed,
              user_id: receipt.userId,
            }),
            updatedAt: input.occurredAt,
            value: receipt,
          };
        },
      });
      return result.status === "replayed"
        ? receiptValue(input.actorUserId, result.resultReference, true)
        : result.value;
    } catch (error) {
      throw mapRepositoryError(error);
    }
  }

  async updateMemberAccess(
    input: Parameters<MemberManagementRepository["updateMemberAccess"]>[0],
  ): Promise<MemberMutationReceipt> {
    try {
      const result = await runIdempotentTransaction({
        runner: this.runner,
        context: {
          organizationId: input.organizationId,
          actorUserId: input.actorUserId,
          requestId: input.requestId,
        },
        claim: {
          id: input.idempotencyId,
          organizationId: input.organizationId,
          actorKind: "user",
          actorOpaqueId: input.actorUserId,
          operation: "access.update_member_access",
          key: input.idempotencyKey,
          requestHash: input.requestHash,
          createdAt: input.occurredAt,
        },
        revalidate: async (transaction) => {
          await requireActiveManager(transaction, input.organizationId, input.actorUserId);
        },
        execute: async (transaction) => {
          await transaction.query({
            text: "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
            values: [`access:last-founder:${input.organizationId}`],
          });
          const state = await loadMemberState(
            transaction,
            input.organizationId,
            input.targetUserId,
            true,
          );
          if (memberAccessVersion(state) !== input.expectedAccessVersion) {
            throw new MemberManagementError("STALE_VERSION");
          }

          const desired = new Set(input.roles);
          const active = new Map(state.roles.map((role) => [role.role, role]));
          if (active.has("founder") && !desired.has("founder")) {
            await requireAnotherFounder(
              transaction,
              input.organizationId,
              state.membership.membership_id,
            );
          }

          for (const role of state.roles) {
            if (desired.has(role.role)) continue;
            const result = await transaction.query<{ id: string }>({
              text: `UPDATE access_role_bindings
                        SET status='revoked',record_version=record_version+1,
                            updated_at=transaction_timestamp()
                      WHERE id=$1 AND organization_id=$2 AND status='active'
                        AND record_version=$3
                  RETURNING id`,
              values: [role.id, input.organizationId, positiveInteger(role.record_version)],
            });
            if (result.rows.length !== 1) throw new MemberManagementError("STALE_VERSION");
          }

          if (state.profile === null) {
            await transaction.query({
              text: `INSERT INTO access_employee_profiles
                (membership_id,organization_id,display_name,employment_type,record_version)
               VALUES ($1,$2,$3,$4,1)`,
              values: [state.membership.membership_id, input.organizationId,
                input.displayName, input.employmentType],
            });
          } else if (
            state.profile.display_name !== input.displayName ||
            state.profile.employment_type !== input.employmentType
          ) {
            const updated = await transaction.query<{ membership_id: string }>({
              text: `UPDATE access_employee_profiles
                        SET display_name=$3,employment_type=$4,
                            record_version=record_version+1
                      WHERE membership_id=$1 AND organization_id=$2 AND record_version=$5
                  RETURNING membership_id`,
              values: [state.membership.membership_id, input.organizationId, input.displayName,
                input.employmentType, positiveInteger(state.profile.record_version)],
            });
            if (updated.rows.length !== 1) throw new MemberManagementError("STALE_VERSION");
          }

          for (const role of input.roles) {
            if (active.has(role)) continue;
            await transaction.query({
              text: `INSERT INTO access_role_bindings
                (id,organization_id,membership_id,user_id,role,status,record_version,
                 created_by_user_id)
               VALUES ($1,$2,$3,$4,$5,'active',1,$6)`,
              values: [input.roleBindingIds[role], input.organizationId,
                state.membership.membership_id, input.targetUserId, role, input.actorUserId],
            });
          }

          await appendEffects(transaction, input.effects);
          const receipt = receiptValue(input.targetUserId, input.effects.audit.id, false);
          return {
            state: "completed" as const,
            resultReference: input.effects.audit.id,
            responseHash: hashRequestPayload({
              receipt_id: receipt.receiptId,
              replayed: receipt.replayed,
              user_id: receipt.userId,
            }),
            updatedAt: input.occurredAt,
            value: receipt,
          };
        },
      });
      return result.status === "replayed"
        ? receiptValue(input.targetUserId, result.resultReference, true)
        : result.value;
    } catch (error) {
      throw mapRepositoryError(error);
    }
  }
}

async function requireActiveMembership(
  transaction: TenantTransaction,
  organizationId: string,
  userId: string,
): Promise<void> {
  const result = await transaction.query<{ id: string }>({
    text: `SELECT membership.id
             FROM access_organization_memberships AS membership
             JOIN identity_users AS identity_user ON identity_user.id=membership.user_id
            WHERE membership.organization_id=$1 AND membership.user_id=$2
              AND membership.status='active' AND identity_user.status='active'
            FOR SHARE OF membership,identity_user`,
    values: [organizationId, userId],
  });
  if (result.rows.length !== 1) throw new MemberManagementError("NOT_FOUND");
}

async function requireActiveManager(
  transaction: TenantTransaction,
  organizationId: string,
  userId: string,
): Promise<void> {
  const result = await transaction.query<{ id: string }>({
    text: `SELECT role_binding.id
             FROM access_organization_memberships AS membership
             JOIN identity_users AS identity_user ON identity_user.id=membership.user_id
             JOIN access_role_bindings AS role_binding
               ON role_binding.organization_id=membership.organization_id
              AND role_binding.membership_id=membership.id
              AND role_binding.user_id=membership.user_id
            WHERE membership.organization_id=$1 AND membership.user_id=$2
              AND membership.status='active' AND identity_user.status='active'
              AND role_binding.status='active' AND role_binding.role IN ('founder','admin')
            LIMIT 1
            FOR SHARE OF membership,identity_user,role_binding`,
    values: [organizationId, userId],
  });
  if (result.rows.length !== 1) throw new MemberManagementError("FORBIDDEN");
}

async function loadMemberState(
  transaction: TenantTransaction,
  organizationId: string,
  userId: string,
  lock: boolean,
): Promise<LockedMemberState> {
  const membership = await transaction.query<MembershipRow>({
    text: `SELECT membership.id AS membership_id,
                  membership.record_version AS membership_record_version,
                  identity_user.normalized_email,identity_user.status AS user_status,
                  membership.status AS membership_status,
                  GREATEST(identity_user.updated_at,membership.updated_at) AS fallback_updated_at
             FROM access_organization_memberships AS membership
             JOIN identity_users AS identity_user ON identity_user.id=membership.user_id
            WHERE membership.organization_id=$1 AND membership.user_id=$2
              AND membership.status='active' AND identity_user.status='active'
            ${lock ? "FOR UPDATE OF membership,identity_user" : ""}`,
    values: [organizationId, userId],
  });
  const membershipRow = membership.rows[0];
  if (!membershipRow) throw new MemberManagementError("NOT_FOUND");
  const profile = await transaction.query<ProfileRow>({
    text: `SELECT display_name,employment_type,record_version,updated_at
             FROM access_employee_profiles
            WHERE membership_id=$1 AND organization_id=$2
            ${lock ? "FOR UPDATE" : ""}`,
    values: [membershipRow.membership_id, organizationId],
  });
  const roles = await transaction.query<RoleRow>({
    text: `SELECT id,role,record_version
             FROM access_role_bindings
            WHERE membership_id=$1 AND organization_id=$2 AND user_id=$3
              AND status='active' AND role IN ('founder','admin','advisor','contractor')
            ORDER BY role,id
            ${lock ? "FOR UPDATE" : ""}`,
    values: [membershipRow.membership_id, organizationId, userId],
  });
  return Object.freeze({
    membership: membershipRow,
    profile: profile.rows[0] ?? null,
    roles: Object.freeze([...roles.rows]),
  });
}

async function requireAnotherFounder(
  transaction: TenantTransaction,
  organizationId: string,
  removedMembershipId: string,
): Promise<void> {
  const result = await transaction.query<{ founder_count: number | string }>({
    text: `SELECT count(*) AS founder_count
             FROM access_role_bindings AS role_binding
             JOIN access_organization_memberships AS membership
               ON membership.id=role_binding.membership_id
              AND membership.organization_id=role_binding.organization_id
            WHERE role_binding.organization_id=$1 AND role_binding.role='founder'
              AND role_binding.status='active' AND membership.status='active'
              AND role_binding.membership_id<>$2`,
    values: [organizationId, removedMembershipId],
  });
  if (Number(result.rows[0]?.founder_count ?? 0) < 1) {
    throw new MemberManagementError("LAST_FOUNDER_REQUIRED");
  }
}

function memberAccessVersion(state: LockedMemberState): string {
  return buildMemberAccessVersion({
    membershipRecordVersion: positiveInteger(state.membership.membership_record_version),
    profileRecordVersion: state.profile === null
      ? null
      : positiveInteger(state.profile.record_version),
    roles: state.roles.map((role) => ({
      bindingId: role.id,
      recordVersion: positiveInteger(role.record_version),
    })),
  });
}

function toOwnProfile(state: LockedMemberState, userId: string): OwnEmployeeProfile {
  return Object.freeze({
    userId,
    normalizedEmail: state.membership.normalized_email,
    displayName: state.profile?.display_name ?? null,
    employmentType: state.profile?.employment_type ?? null,
    recordVersion: state.profile === null ? null : positiveInteger(state.profile.record_version),
    updatedAt: timestamp(state.profile?.updated_at ?? state.membership.fallback_updated_at),
  });
}

function inferEmploymentType(roles: readonly RoleRow[]): EmploymentType {
  if (roles.some((role) => role.role === "contractor")) return "PART_TIME";
  if (roles.some((role) => role.role === "founder" || role.role === "advisor")) {
    return "FULL_TIME";
  }
  throw new MemberManagementError("PROFILE_SETUP_REQUIRED");
}

async function appendEffects(
  transaction: TenantTransaction,
  effects: MutationEffectBundle,
): Promise<void> {
  const auditTransaction: AtomicMutationTransaction = {
    async query<Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) {
      const result = await transaction.query<Row>({ text, values });
      return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
    },
  };
  await appendAtomicMutationEffects(auditTransaction, effects);
}

function receiptValue(userId: string, receiptId: string, replayed: boolean): MemberMutationReceipt {
  return Object.freeze({ userId, receiptId, replayed });
}

function positiveInteger(value: number | string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new MemberManagementError("UNAVAILABLE");
  return parsed;
}

function timestamp(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new MemberManagementError("UNAVAILABLE");
  return date.toISOString();
}

function mapRepositoryError(error: unknown): MemberManagementError {
  if (error instanceof MemberManagementError) return error;
  if (error instanceof IdempotencyExecutionError) {
    return new MemberManagementError("IDEMPOTENCY_CONFLICT");
  }
  const constraint = databaseConstraint(error);
  if (constraint === "access_role_bindings_last_founder_check") {
    return new MemberManagementError("LAST_FOUNDER_REQUIRED");
  }
  if (
    constraint === "access_role_bindings_contractor_exclusive_check" ||
    constraint === "access_role_bindings_employment_type_check" ||
    constraint === "access_employee_profiles_employment_type_roles_check"
  ) {
    return new MemberManagementError("ROLE_CONFLICT");
  }
  if (databaseCode(error) === "23505") return new MemberManagementError("STALE_VERSION");
  return new MemberManagementError("UNAVAILABLE");
}

function databaseConstraint(error: unknown): string | null {
  const value = error instanceof Error
    ? (error as Error & { readonly constraint?: unknown }).constraint
    : null;
  return typeof value === "string" ? value : null;
}

function databaseCode(error: unknown): string | null {
  const value = error instanceof Error ? (error as Error & { readonly code?: unknown }).code : null;
  return typeof value === "string" ? value : null;
}
