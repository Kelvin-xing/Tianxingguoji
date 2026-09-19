import "server-only";
import {
  isK12BusinessCategory, isTrialLevel,
  type TrialPrincipal,
} from "../domain/trial-policy.ts";

export interface TrialPrincipalTransaction {
  query<Row extends Record<string, unknown>>(
    sql: string, values?: readonly unknown[],
  ): Promise<{ readonly rows: readonly Row[] }>;
}

/**
 * null means never enrolled. A disabled trial member returns active:false and
 * must never fall back to historical roles. Mutations hold a shared lock until
 * commit; revocation/level changes must acquire the conflicting row lock.
 */
export async function loadTrialPrincipal(
  transaction: TrialPrincipalTransaction,
  input: Readonly<{ userId: string; organizationId: string; lock?: boolean }>,
): Promise<TrialPrincipal | null> {
  const result = await transaction.query<{
    user_id: string; organization_id: string; level: unknown; categories: unknown;
    active: boolean; record_version: string | number;
  }>(`SELECT t.user_id,t.organization_id,t.level,t.categories,t.record_version,
      (t.status='active' AND m.status='active' AND u.status='active' AND o.status='active') AS active
    FROM access_trial_members t
    JOIN access_organization_memberships m ON m.id=t.membership_id AND m.organization_id=t.organization_id
    JOIN identity_users u ON u.id=t.user_id
    JOIN access_organizations o ON o.id=t.organization_id
    WHERE t.organization_id=$1 AND t.user_id=$2
    ${input.lock ? "FOR SHARE OF t,m,u,o" : ""}`, [input.organizationId, input.userId]);
  if (result.rows.length === 0) return null;
  const row = result.rows[0]!;
  const version = Number(row.record_version);
  if (result.rows.length !== 1 || row.user_id !== input.userId || row.organization_id !== input.organizationId
    || !isTrialLevel(row.level) || !Array.isArray(row.categories)
    || !row.categories.every(isK12BusinessCategory)
    || typeof row.active !== "boolean" || !Number.isSafeInteger(version) || version < 1) {
    throw new Error("Invalid authoritative trial principal.");
  }
  return Object.freeze({
    userId: row.user_id, organizationId: row.organization_id,
    level: row.level, categories: Object.freeze([...row.categories]),
    active: row.active, recordVersion: version,
  });
}
