import "server-only";
import { appendAtomicMutationEffects } from "../../audit/server.ts";
import { hashRequestPayload } from "../../shared/public.ts";
import { IdempotencyExecutionError, runIdempotentTransaction, type TenantTransaction, type TenantTransactionRunner } from "../../shared/server.ts";
import { TrialMemberError, type TrialMemberMutation, type TrialMemberRepository, type TrialMemberView } from "../application/trial-member-management.ts";
import { loadTrialPrincipal } from "./postgresql-trial-principal.ts";

export class PostgresqlTrialMemberRepository implements TrialMemberRepository {
  private readonly runner: TenantTransactionRunner;
  constructor(runner: TenantTransactionRunner) { this.runner = runner; }

  async list(input: Readonly<{ organizationId: string; actorUserId: string }>): Promise<readonly TrialMemberView[]> {
    return this.runner.run(input, async (tx) => {
      await requireFounder(tx, input, false);
      const result = await tx.query<{
        user_id: string; membership_id: string; display_name: string; email: string;
        level: TrialMemberView["level"]; categories: TrialMemberView["categories"];
        status: TrialMemberView["status"]; record_version: string | number | null;
      }>({ text: `SELECT m.user_id,m.id AS membership_id,p.display_name,u.normalized_email AS email,
          t.level,COALESCE(t.categories,'{}') AS categories,t.status,t.record_version
        FROM access_organization_memberships m
        JOIN identity_users u ON u.id=m.user_id
        JOIN access_employee_profiles p ON p.membership_id=m.id AND p.organization_id=m.organization_id
        LEFT JOIN access_trial_members t ON t.membership_id=m.id
        WHERE m.organization_id=$1 AND m.status IN ('active','invited','disabled') AND u.status IN ('active','invited')
        ORDER BY p.display_name,m.id`, values: [input.organizationId] });
      return result.rows.map((row) => ({ userId: row.user_id, membershipId: row.membership_id,
        displayName: row.display_name, email: row.email, level: row.level, categories: row.categories,
        status: row.status, recordVersion: row.record_version === null ? null : Number(row.record_version) }));
    });
  }

  async update(input: TrialMemberMutation) {
    try {
      const result = await runIdempotentTransaction({
        runner: this.runner, context: { organizationId: input.organizationId, actorUserId: input.actorUserId, requestId: input.requestId },
        claim: { id: input.idempotencyId, organizationId: input.organizationId, actorKind: "user", actorOpaqueId: input.actorUserId,
          operation: "access.update_trial_member", key: input.idempotencyKey, requestHash: input.requestHash, createdAt: input.occurredAt },
        revalidate: async (tx) => { await requireFounder(tx, input, true); },
        execute: async (tx) => {
          const member = await tx.query<{ id: string; status: string }>({ text: `SELECT m.id,m.status
            FROM access_organization_memberships m JOIN identity_users u ON u.id=m.user_id
            JOIN access_employee_profiles p ON p.membership_id=m.id AND p.organization_id=m.organization_id
            WHERE m.organization_id=$1 AND m.user_id=$2 AND m.status IN ('active','invited','disabled') AND u.status IN ('active','invited')
            FOR UPDATE OF m,u,p`, values: [input.organizationId,input.targetUserId] });
          if (member.rows.length !== 1) throw new TrialMemberError("NOT_FOUND");
          if (member.rows[0]!.status === "disabled" && input.status === "active") throw new TrialMemberError("INVALID");
          const membershipId = member.rows[0]!.id;
          const existing = await tx.query<{ record_version: string | number }>({
            text: "SELECT record_version FROM access_trial_members WHERE membership_id=$1 FOR UPDATE", values: [membershipId] });
          const version = existing.rows[0] ? Number(existing.rows[0].record_version) : null;
          if (version !== input.expectedRecordVersion) throw new TrialMemberError("STALE_VERSION");
          if (version === null) {
            await tx.query({ text: `INSERT INTO access_trial_members
              (membership_id,organization_id,user_id,level,categories,status,created_by_user_id,updated_by_user_id)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$7)`, values: [membershipId,input.organizationId,input.targetUserId,input.level,input.categories,input.status,input.actorUserId] });
          } else {
            await tx.query({ text: `UPDATE access_trial_members SET level=$2,categories=$3,status=$4,
              updated_by_user_id=$5,record_version=record_version+1 WHERE membership_id=$1`,
              values: [membershipId,input.level,input.categories,input.status,input.actorUserId] });
          }
          await tx.query({ text: `UPDATE access_role_bindings SET status='revoked',record_version=record_version+1
            WHERE membership_id=$1 AND organization_id=$2 AND status='active' AND role<>$3`,
            values: [membershipId,input.organizationId,input.level] });
          await tx.query({ text: `INSERT INTO access_role_bindings
            (id,organization_id,membership_id,user_id,role,status,created_by_user_id)
            SELECT $1,$2,$3,$4,$5,'active',$6 WHERE NOT EXISTS (
              SELECT 1 FROM access_role_bindings WHERE membership_id=$3 AND organization_id=$2 AND status='active' AND role=$5)`,
            values: [input.roleBindingId,input.organizationId,membershipId,input.targetUserId,input.level,input.actorUserId] });
          await tx.query({ text: `UPDATE access_organization_memberships m
            SET status=CASE WHEN $3='disabled' THEN 'disabled' ELSE u.status END,
                record_version=m.record_version+1,updated_at=transaction_timestamp()
            FROM identity_users u WHERE m.id=$1 AND m.organization_id=$2 AND u.id=m.user_id
              AND m.status IS DISTINCT FROM CASE WHEN $3='disabled' THEN 'disabled' ELSE u.status END`,
            values: [membershipId,input.organizationId,input.status] });
          await appendAtomicMutationEffects({ async query<Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) {
            const result = await tx.query<Row>({ text, values });
            return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
          } }, input.effects);
          const receipt = { userId: input.targetUserId, receiptId: input.effects.audit.id, replayed: false };
          return { state: "completed" as const, resultReference: receipt.receiptId,
            responseHash: hashRequestPayload({ receipt_id: receipt.receiptId, user_id: receipt.userId }), updatedAt: input.occurredAt, value: receipt };
        },
      });
      return result.status === "executed" ? result.value
        : { userId: input.targetUserId, receiptId: result.resultReference, replayed: true };
    } catch (error) {
      if (error instanceof TrialMemberError) throw error;
      if (error instanceof IdempotencyExecutionError) {
        throw new TrialMemberError("IDEMPOTENCY_CONFLICT");
      }
      const postgres = error as { code?: string; constraint?: string; message?: string };
      if (postgres.code === "42501") throw new TrialMemberError("FORBIDDEN");
      if (postgres.constraint === "access_role_bindings_last_founder_check" || postgres.message === "last trial Founder required") throw new TrialMemberError("LAST_FOUNDER_REQUIRED");
      if (postgres.code === "40001" || postgres.code === "40P01") throw new TrialMemberError("STALE_VERSION");
      throw new TrialMemberError("UNAVAILABLE");
    }
  }
}

async function requireFounder(tx: TenantTransaction, input: Readonly<{ organizationId: string; actorUserId: string }>, mutation: boolean) {
  const organization = await tx.query({ text: `SELECT id FROM access_organizations WHERE id=$1 AND status='active' ${mutation ? "FOR UPDATE" : "FOR SHARE"}`, values: [input.organizationId] });
  if (organization.rows.length !== 1) throw new TrialMemberError("FORBIDDEN");
  const trial = await loadTrialPrincipal({ query: (text,values) => tx.query({text,values}) }, { userId: input.actorUserId, organizationId: input.organizationId, lock: true });
  if (trial) {
    if (trial.active && trial.level === "founder") return;
    throw new TrialMemberError("FORBIDDEN");
  }
  const initial = await tx.query({ text: `SELECT rb.id FROM access_role_bindings rb
    JOIN access_organization_memberships m ON m.id=rb.membership_id AND m.status='active'
    JOIN identity_users u ON u.id=rb.user_id AND u.status='active'
    WHERE rb.organization_id=$1 AND rb.user_id=$2 AND rb.status='active' AND rb.role='founder'
      AND NOT EXISTS (SELECT 1 FROM access_trial_members WHERE organization_id=$1)
    FOR SHARE OF rb,m,u`, values: [input.organizationId,input.actorUserId] });
  if (initial.rows.length !== 1) throw new TrialMemberError("FORBIDDEN");
}
