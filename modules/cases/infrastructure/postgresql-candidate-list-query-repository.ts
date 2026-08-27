import "server-only";

import type { TenantTransaction, TenantTransactionRunner } from "../../shared/server.ts";
import {
  CandidateListQueryError,
  isCandidateListQueryError,
  type CandidateListFounderApprovalView,
  type CandidateListGuardianDecisionView,
  type CandidateListQueryItemView,
  type CandidateListQueryRepository,
  type CandidateListVersionView,
} from "../application/candidate-list-query-service.ts";
import {
  CANDIDATE_LIST_STATUSES,
  type CandidateListStatus,
  type FounderListDecision,
  type GuardianConfirmationChannel,
  type GuardianListDecision,
} from "../domain/candidate-list-case-flow.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;

interface CandidateListVersionRow extends Record<string, unknown> {
  readonly id: string;
  readonly version_number: number | string;
  readonly previous_version_id: string | null;
  readonly school_set_sha256: string;
  readonly status: string;
  readonly record_version: number | string;
  readonly change_summary: string;
  readonly created_by_user_id: string;
  readonly created_at: Date | string;
  readonly submitted_at: Date | string | null;
  readonly founder_decision: string | null;
  readonly founder_decided_by_user_id: string | null;
  readonly founder_decided_at: Date | string | null;
  readonly founder_decision_reason: string | null;
  readonly founder_decision_sha256: string | null;
  readonly guardian_id: string | null;
  readonly guardian_relationship_id: string | null;
  readonly guardian_decision: string | null;
  readonly guardian_decided_at: Date | string | null;
  readonly guardian_confirmation_channel: string | null;
  readonly guardian_recorded_by_user_id: string | null;
  readonly guardian_recorded_at: Date | string | null;
  readonly guardian_bound_founder_decision_sha256: string | null;
}

interface CandidateListItemRow extends Record<string, unknown> {
  readonly id: string;
  readonly list_version_id: string;
  readonly school_id: string;
  readonly pinned_resolved_revision_id: string;
  readonly pinned_resolution_sha256: string;
  readonly ordinal: number | string;
  readonly school_target_id: string | null;
  readonly application_deadline: Date | string | null;
}

export class PostgresqlCandidateListQueryRepository implements CandidateListQueryRepository {
  private readonly runner: TenantTransactionRunner;
  constructor(runner: TenantTransactionRunner) { this.runner = runner; }

  list(input: Parameters<CandidateListQueryRepository["list"]>[0]) {
    return this.runner.run({
      organizationId: input.organizationId,
      actorKind: "user",
      actorOpaqueId: input.actorUserId,
      actorUserId: input.actorUserId,
      requestId: input.requestId,
    }, async (transaction) => {
      await assertAuthorized(transaction, input.caseId);
      const versions = await transaction.query<CandidateListVersionRow>({
          text: `SELECT id,version_number,previous_version_id,school_set_sha256,status,
                        record_version,change_summary,created_by_user_id,created_at,submitted_at,
                        founder_decision,founder_decided_by_user_id,founder_decided_at,
                        founder_decision_reason,founder_decision_sha256,guardian_id,
                        guardian_relationship_id,guardian_decision,guardian_decided_at,
                        guardian_confirmation_channel,guardian_recorded_by_user_id,
                        guardian_recorded_at,guardian_bound_founder_decision_sha256
                   FROM cases_candidate_school_list_versions
                  WHERE organization_id=$1 AND service_case_id=$2
                    AND ($3::bigint IS NULL OR version_number < $3 OR
                      (version_number = $3 AND id::text COLLATE "C" > $4))
                  ORDER BY version_number DESC,id::text COLLATE "C" ASC
                  LIMIT $5`,
          values: [input.organizationId,input.caseId,input.cursor?.versionNumber ?? null,
            input.cursor?.id ?? null,input.limit + 1],
      });
      const pageRows = versions.rows.slice(0,input.limit);
      const ids = pageRows.map((row) => uuid(row.id));
      const itemsByVersion = await readItems(transaction,input,ids);
      const items = pageRows.map((row) => versionView(row,itemsByVersion.get(uuid(row.id)) ?? []));
      return Object.freeze({
        items: Object.freeze(items),
        hasMore: versions.rows.length > input.limit,
      });
    }).catch((error) => {
      if (isCandidateListQueryError(error)) throw error;
      throw new CandidateListQueryError("CANDIDATE_LIST_QUERY_UNAVAILABLE");
    });
  }
}

async function assertAuthorized(transaction: TenantTransaction, caseId: string): Promise<void> {
  const result = await transaction.query<{ allowed: boolean }>({
    text: `SELECT (cases_actor_has_active_case_role($1,'founder',false)
                  OR cases_actor_has_active_case_role($1,'advisor',true)) AS allowed`,
    values: [caseId],
  });
  if (result.rows[0]?.allowed !== true) {
    throw new CandidateListQueryError("CANDIDATE_LIST_QUERY_NOT_FOUND");
  }
}

async function readItems(
  transaction: TenantTransaction,
  input: Parameters<CandidateListQueryRepository["list"]>[0],
  versionIds: readonly string[],
): Promise<Map<string, readonly CandidateListQueryItemView[]>> {
  if (versionIds.length === 0) return new Map();
  const result = await transaction.query<CandidateListItemRow>({
    text: `SELECT id,list_version_id,school_id,pinned_resolved_revision_id,
                  pinned_resolution_sha256,ordinal,school_target_id,application_deadline
             FROM cases_candidate_school_list_items
            WHERE organization_id=$1 AND service_case_id=$2
              AND list_version_id=ANY($3::uuid[])
            ORDER BY list_version_id::text COLLATE "C" ASC,ordinal ASC,id::text COLLATE "C" ASC`,
    values: [input.organizationId,input.caseId,versionIds],
  });
  const grouped = new Map<string,CandidateListQueryItemView[]>();
  for (const row of result.rows) {
    const versionId = uuid(row.list_version_id);
    const group = grouped.get(versionId) ?? [];
    group.push(itemView(row));
    grouped.set(versionId,group);
  }
  return new Map([...grouped].map(([id,items]) => [id,Object.freeze(items)]));
}

function versionView(
  row: CandidateListVersionRow,
  items: readonly CandidateListQueryItemView[],
): CandidateListVersionView {
  const status = candidateStatus(row.status);
  return Object.freeze({
    id: uuid(row.id),
    versionNumber: positiveInteger(row.version_number),
    previousVersionId: nullableUuid(row.previous_version_id),
    schoolSetSha256: sha256(row.school_set_sha256),
    status,
    recordVersion: positiveInteger(row.record_version),
    changeSummary: nonEmpty(row.change_summary),
    createdByUserId: uuid(row.created_by_user_id),
    createdAt: timestamp(row.created_at),
    submittedAt: nullableTimestamp(row.submitted_at),
    items: Object.freeze([...items]),
    founderApproval: founderApproval(row),
    guardianDecision: guardianDecision(row),
  });
}

function itemView(row: CandidateListItemRow): CandidateListQueryItemView {
  return Object.freeze({
    id: uuid(row.id),
    schoolId: uuid(row.school_id),
    pinnedResolvedRevisionId: uuid(row.pinned_resolved_revision_id),
    pinnedResolutionSha256: sha256(row.pinned_resolution_sha256),
    ordinal: positiveInteger(row.ordinal),
    schoolTargetId: nullableUuid(row.school_target_id),
    applicationDeadline: nullableTimestamp(row.application_deadline),
  });
}

function founderApproval(row: CandidateListVersionRow): CandidateListFounderApprovalView | null {
  if (row.founder_decision === null && row.founder_decided_by_user_id === null &&
      row.founder_decided_at === null && row.founder_decision_reason === null &&
      row.founder_decision_sha256 === null) return null;
  if (row.founder_decision !== "approved" && row.founder_decision !== "rejected") unavailable();
  return Object.freeze({
    decision: row.founder_decision as FounderListDecision,
    decidedByUserId: uuid(row.founder_decided_by_user_id),
    decidedAt: timestamp(row.founder_decided_at),
    reason: founderReason(row.founder_decision,row.founder_decision_reason),
    decisionSha256: sha256(row.founder_decision_sha256),
  });
}

function guardianDecision(row: CandidateListVersionRow): CandidateListGuardianDecisionView | null {
  if (row.guardian_id === null && row.guardian_relationship_id === null &&
      row.guardian_decision === null && row.guardian_decided_at === null &&
      row.guardian_confirmation_channel === null && row.guardian_recorded_by_user_id === null &&
      row.guardian_recorded_at === null && row.guardian_bound_founder_decision_sha256 === null) return null;
  if (row.guardian_decision !== "confirmed" && row.guardian_decision !== "not_confirmed") unavailable();
  if (row.guardian_confirmation_channel !== "phone" &&
      row.guardian_confirmation_channel !== "wechat" &&
      row.guardian_confirmation_channel !== "in_person") unavailable();
  return Object.freeze({
    guardianId: uuid(row.guardian_id),
    guardianRelationshipId: uuid(row.guardian_relationship_id),
    decision: row.guardian_decision as GuardianListDecision,
    decidedAt: timestamp(row.guardian_decided_at),
    channel: row.guardian_confirmation_channel as GuardianConfirmationChannel,
    recordedByUserId: uuid(row.guardian_recorded_by_user_id),
    recordedAt: timestamp(row.guardian_recorded_at),
    boundFounderDecisionSha256: sha256(row.guardian_bound_founder_decision_sha256),
  });
}

function candidateStatus(value: string): CandidateListStatus {
  if (!CANDIDATE_LIST_STATUSES.includes(value as CandidateListStatus)) unavailable();
  return value as CandidateListStatus;
}
function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) unavailable();
  return value.toLowerCase();
}
function nullableUuid(value: unknown): string | null { return value === null ? null : uuid(value); }
function sha256(value: unknown): string {
  if (typeof value !== "string" || !SHA256.test(value)) unavailable();
  return value;
}
function positiveInteger(value: unknown): number {
  const parsed = typeof value === "string" && /^[1-9][0-9]*$/.test(value) ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 1) unavailable();
  return parsed;
}
function nonEmpty(value: unknown): string {
  if (typeof value !== "string" || value.trim().length < 1) unavailable();
  return value;
}
function founderReason(decision: FounderListDecision,value: unknown): string | null {
  if (decision === "approved" && (value === null || value === "")) return null;
  if (typeof value !== "string" || value.trim().length < 1) unavailable();
  return value;
}
function timestamp(value: unknown): string {
  if (!(typeof value === "string" || value instanceof Date)) unavailable();
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) unavailable();
  return parsed.toISOString();
}
function nullableTimestamp(value: unknown): string | null { return value === null ? null : timestamp(value); }
function unavailable(): never {
  throw new CandidateListQueryError("CANDIDATE_LIST_QUERY_UNAVAILABLE");
}
