import "server-only";

import { appendAtomicMutationEffects } from "../../audit/server.ts";
import { hashRequestPayload } from "../../shared/public.ts";
import type { TenantTransaction, TenantTransactionRunner } from "../../shared/server.ts";
import {
  DuplicateReviewError,
  GUARDIAN_DUPLICATE_FIELDS,
  STUDENT_DUPLICATE_FIELDS,
  isDuplicateReviewError,
  type DuplicateCandidateDetail,
  type DuplicateCandidateSummary,
  type DuplicateCorrectionAcknowledgement,
  type DuplicateFieldSelection,
  type DuplicateMatchSignalName,
  type DuplicateMergeAcknowledgement,
  type DuplicateMergeReceipt,
  type DuplicateProfile,
  type DuplicateRecordSearchItem,
  type DuplicateReviewEntityType,
  type DuplicateReviewRepository,
} from "../application/duplicate-review-service.ts";

const CREATE_OPERATION = "crm.create_duplicate_candidate";
const MERGE_OPERATION = "crm.merge_duplicate_candidate";
const CORRECT_OPERATION = "crm.correct_duplicate_merge";

interface CandidateRow extends Record<string, unknown> {
  id: string; entity_type: DuplicateReviewEntityType; left_record_id: string; right_record_id: string;
  left_display_label: string; right_display_label: string; matching_signals: string[];
  status: "review_required" | "merged"; merge_id: string | null; record_version: number | string;
}
interface RecordRow extends Record<string, unknown> {
  id: string; display_name: string; date_of_birth: string | null; contact_email: string | null;
  contact_phone: string | null; email: string | null; phone: string | null;
  status: string; record_version: number | string;
}
interface MergeRow extends Record<string, unknown> {
  id: string; candidate_id: string; entity_type: DuplicateReviewEntityType; source_record_id: string;
  canonical_record_id: string; provenance_revision_id: string; status: "active" | "corrected";
  correction_id: string | null; record_version: number | string;
}
interface ReceiptRow extends Record<string, unknown> {
  request_hash: string; state: string; result_reference: string | null; response_hash: string | null;
}

export class PostgresqlDuplicateReviewRepository implements DuplicateReviewRepository {
  private readonly runner: TenantTransactionRunner;

  constructor(runner: TenantTransactionRunner) {
    this.runner = runner;
  }

  searchRecords(input: Parameters<DuplicateReviewRepository["searchRecords"]>[0]) {
    return this.run(input, async (tx) => {
      await assertRole(tx, input, "review");
      const table = input.entityType === "student" ? "crm_students" : "crm_guardians";
      const email = input.entityType === "student" ? "record.contact_email" : "record.email";
      const phone = input.entityType === "student" ? "record.contact_phone" : "record.phone";
      const scope = advisorScopeSql(input.entityType, "record.id", 3);
      const result = await tx.query<RecordRow>(
        `SELECT record.id, record.display_name, NULL::text AS date_of_birth,
                ${email} AS contact_email, ${phone} AS contact_phone,
                NULL::text AS email, NULL::text AS phone, record.status, record.record_version
           FROM ${table} AS record
          WHERE record.status = 'active'
            AND (position(lower($1) IN lower(record.display_name)) > 0
              OR position(lower($1) IN lower(coalesce(${email},''))) > 0
              OR position(lower($1) IN lower(coalesce(${phone},''))) > 0)
            AND ($2::text <> 'advisor' OR ${scope})
          ORDER BY lower(record.display_name) COLLATE "C", record.id LIMIT 20`,
        [input.query, input.actorRole, input.actorUserId],
      );
      return Object.freeze(result.rows.map((row): DuplicateRecordSearchItem => Object.freeze({
        id: row.id, entityType: input.entityType, displayLabel: row.display_name,
        contactHint: contactHint(row.contact_email ?? row.contact_phone),
      })));
    });
  }

  listCandidates(input: Parameters<DuplicateReviewRepository["listCandidates"]>[0]) {
    return this.run(input, async (tx) => {
      await assertRole(tx, input, "review");
      const result = await tx.query<CandidateRow>(
        `SELECT id, entity_type, left_record_id, right_record_id, left_display_label,
                right_display_label, matching_signals, status, merge_id, record_version
           FROM crm_duplicate_candidates AS candidate
          WHERE entity_type = $1 AND status = $2
          ORDER BY created_at, id LIMIT 100`, [input.entityType, input.status],
      );
      const visible: DuplicateCandidateSummary[] = [];
      for (const row of result.rows) {
        if (await canReviewPair(tx, input, row.entity_type, row.left_record_id, row.right_record_id)) {
          visible.push(toSummary(row));
        }
      }
      return Object.freeze(visible);
    });
  }

  findCandidate(input: Parameters<DuplicateReviewRepository["findCandidate"]>[0]) {
    return this.run(input, async (tx) => {
      await assertRole(tx, input, "review");
      const row = await selectCandidate(tx, input.candidateId, false);
      if (!row || !await canReviewPair(tx, input, row.entity_type, row.left_record_id, row.right_record_id)) {
        return null;
      }
      return candidateDetail(tx, row);
    });
  }

  createCandidate(input: Parameters<DuplicateReviewRepository["createCandidate"]>[0]) {
    return this.run(input, async (tx) => {
      const receipt = await claimReceipt(tx, input, CREATE_OPERATION);
      await assertRole(tx, input, "review");
      if (receipt) {
        const row = await selectCandidate(tx, receipt.reference, false);
        if (!row) conflict();
        const replay = toInitialSummary(row);
        assertResponseHash(receipt.responseHash, candidateHash(replay));
        return replay;
      }
      const [leftId, rightId] = [input.leftRecordId, input.rightRecordId].sort();
      const rows = await lockRecords(tx, input.entityType, leftId, rightId);
      if (rows.length !== 2 || !await canReviewPair(tx, input, input.entityType, leftId, rightId)) notFound();
      const signals = matchingSignals(input.entityType, rows[0]!, rows[1]!);
      if (signals.length === 0) throw new DuplicateReviewError("DUPLICATE_REVIEW_NO_MATCH");
      const result = await tx.query<CandidateRow>(
        `INSERT INTO crm_duplicate_candidates
          (id,organization_id,entity_type,left_record_id,right_record_id,left_display_label,
           right_display_label,matching_signals,created_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id, entity_type, left_record_id, right_record_id, left_display_label,
                   right_display_label, matching_signals, status, merge_id, record_version`,
        [input.candidateId, input.organizationId, input.entityType, leftId, rightId,
          rows[0]!.display_name, rows[1]!.display_name, signals, input.actorUserId],
      );
      const candidate = toSummary(required(result.rows[0]));
      await appendAtomicMutationEffects(tx, input.effects);
      await completeReceipt(tx, input, CREATE_OPERATION, candidate.candidateId, candidateHash(candidate));
      return candidate;
    });
  }

  mergeCandidate(input: Parameters<DuplicateReviewRepository["mergeCandidate"]>[0]) {
    return this.run(input, async (tx) => {
      const receipt = await claimReceipt(tx, input, MERGE_OPERATION);
      await assertRole(tx, input, "merge");
      if (receipt) {
        const replay = await selectMergeReceipt(tx, receipt.reference);
        if (!replay) conflict();
        const initial = Object.freeze({ ...replay, recordVersion: 1 });
        assertResponseHash(receipt.responseHash, mergeReceiptHash(initial));
        return initial;
      }
      const candidate = await selectCandidate(tx, input.candidateId, true);
      if (!candidate) notFound();
      if (version(candidate.record_version) !== input.expectedCandidateRecordVersion) stale();
      if (candidate.status !== "review_required" || candidate.merge_id) conflict();
      const pair = new Set([candidate.left_record_id, candidate.right_record_id]);
      if (!pair.has(input.sourceRecordId) || !pair.has(input.canonicalRecordId) ||
          input.sourceRecordId === input.canonicalRecordId) conflict();
      const rows = await lockRecords(tx, candidate.entity_type, candidate.left_record_id,
        candidate.right_record_id);
      const source = rows.find((row) => row.id === input.sourceRecordId);
      const canonical = rows.find((row) => row.id === input.canonicalRecordId);
      if (!source || !canonical) notFound();
      if (version(source.record_version) !== input.expectedSourceRecordVersion ||
          version(canonical.record_version) !== input.expectedCanonicalRecordVersion) stale();
      const selections = validateSelections(candidate.entity_type, input.fieldSelections, pair);
      if (await hasActiveAliasInvolvement(tx, candidate.entity_type,
        [input.sourceRecordId, input.canonicalRecordId])) conflict();
      await tx.query(
        `INSERT INTO crm_duplicate_merges
          (id,organization_id,candidate_id,entity_type,source_record_id,canonical_record_id,
           provenance_revision_id,reason_code,approved_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [input.mergeId, input.organizationId, candidate.id, candidate.entity_type,
          input.sourceRecordId, input.canonicalRecordId, input.provenanceRevisionId,
          input.reasonCode, input.actorUserId],
      );
      await tx.query(
        `INSERT INTO crm_duplicate_alias_revisions
          (id,organization_id,merge_id,entity_type,source_record_id,target_record_id,
           revision_number,created_by_user_id) VALUES ($1,$2,$3,$4,$5,$6,1,$7)`,
        [input.aliasRevisionId, input.organizationId, input.mergeId, candidate.entity_type,
          input.sourceRecordId, input.canonicalRecordId, input.actorUserId],
      );
      for (const selection of selections) {
        await tx.query(
          `INSERT INTO crm_duplicate_field_provenance_revisions
            (revision_id,field_name,organization_id,merge_id,entity_type,selected_record_id,
             revision_number,created_by_user_id) VALUES ($1,$2,$3,$4,$5,$6,1,$7)`,
          [input.provenanceRevisionId, selection.fieldName, input.organizationId, input.mergeId,
            candidate.entity_type, selection.sourceRecordId, input.actorUserId],
        );
      }
      const candidateUpdate = await tx.query(
        `UPDATE crm_duplicate_candidates SET status='merged', merge_id=$2,
             record_version=record_version+1, updated_at=transaction_timestamp()
          WHERE id=$1 AND status='review_required' AND record_version=$3`,
        [candidate.id, input.mergeId, input.expectedCandidateRecordVersion],
      );
      if (candidateUpdate.rowCount !== 1) stale();
      const acknowledgement: DuplicateMergeReceipt = Object.freeze({ mergeId: input.mergeId,
        candidateId: candidate.id, entityType: candidate.entity_type,
        sourceRecordId: input.sourceRecordId, canonicalRecordId: input.canonicalRecordId,
        provenanceRevisionId: input.provenanceRevisionId, recordVersion: 1 });
      await appendAtomicMutationEffects(tx, input.effects);
      await completeReceipt(tx, input, MERGE_OPERATION, input.mergeId, mergeReceiptHash(acknowledgement));
      return acknowledgement;
    });
  }

  correctMerge(input: Parameters<DuplicateReviewRepository["correctMerge"]>[0]) {
    return this.run(input, async (tx) => {
      const receipt = await claimReceipt(tx, input, CORRECT_OPERATION);
      await assertRole(tx, input, "merge");
      if (receipt) {
        const replay = await selectCorrection(tx, receipt.reference);
        if (!replay) conflict();
        assertResponseHash(receipt.responseHash, correctionHash(replay));
        return replay;
      }
      const mergeResult = await tx.query<MergeRow>(
        `SELECT id,candidate_id,entity_type,source_record_id,canonical_record_id,
                provenance_revision_id,status,correction_id,record_version
           FROM crm_duplicate_merges WHERE id=$1 FOR UPDATE`, [input.mergeId],
      );
      const merge = mergeResult.rows[0]; if (!merge) notFound();
      if (version(merge.record_version) !== input.expectedMergeRecordVersion) stale();
      if (merge.status !== "active" || merge.correction_id) conflict();
      if ((await lockRecords(tx, merge.entity_type, merge.source_record_id,
        merge.canonical_record_id)).length !== 2) notFound();
      const alias = await latestAlias(tx, merge.entity_type, merge.source_record_id, true);
      if (!alias || alias.target_record_id !== merge.canonical_record_id || alias.merge_id !== merge.id) conflict();
      const nextRevision = version(alias.revision_number) + 1;
      await tx.query(
        `INSERT INTO crm_duplicate_merge_corrections
          (id,organization_id,merge_id,source_record_id,canonical_record_id,
           restored_alias_target_id,reason_code,corrected_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$4,$6,$7)`,
        [input.correctiveRevisionId, input.organizationId, merge.id, merge.source_record_id,
          merge.canonical_record_id, input.reasonCode, input.actorUserId],
      );
      await tx.query(
        `INSERT INTO crm_duplicate_alias_revisions
          (id,organization_id,merge_id,correction_id,entity_type,source_record_id,target_record_id,
           revision_number,created_by_user_id) VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8)`,
        [input.aliasRevisionId, input.organizationId, merge.id, input.correctiveRevisionId,
          merge.entity_type, merge.source_record_id, nextRevision, input.actorUserId],
      );
      for (const fieldName of fields(merge.entity_type)) {
        await tx.query(
          `INSERT INTO crm_duplicate_field_provenance_revisions
            (revision_id,field_name,organization_id,merge_id,correction_id,entity_type,
             selected_record_id,revision_number,created_by_user_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [input.provenanceRevisionId, fieldName, input.organizationId, merge.id,
            input.correctiveRevisionId, merge.entity_type, merge.source_record_id, nextRevision,
            input.actorUserId],
        );
      }
      const updated = await tx.query(
        `UPDATE crm_duplicate_merges SET status='corrected',correction_id=$2,
             record_version=record_version+1,updated_at=transaction_timestamp()
          WHERE id=$1 AND status='active' AND record_version=$3`,
        [merge.id, input.correctiveRevisionId, input.expectedMergeRecordVersion],
      );
      if (updated.rowCount !== 1) stale();
      const acknowledgement: DuplicateCorrectionAcknowledgement = Object.freeze({
        correctiveRevisionId: input.correctiveRevisionId, mergeId: merge.id,
        sourceRecordId: merge.source_record_id, canonicalRecordId: merge.canonical_record_id,
        restoredAliasTargetId: merge.source_record_id, recordVersion: 1,
      });
      await appendAtomicMutationEffects(tx, input.effects);
      await completeReceipt(tx, input, CORRECT_OPERATION, input.correctiveRevisionId,
        correctionHash(acknowledgement));
      return acknowledgement;
    });
  }

  private run<T>(input: { organizationId: string; actorUserId: string }, operation: (tx: Db) => Promise<T>) {
    return this.runner.run(input, async (tenantTx) => {
      try { return await operation(adapt(tenantTx)); }
      catch (cause) {
        if (isDuplicateReviewError(cause)) throw cause;
        if (isConflictConstraint(cause)) conflict();
        throw new DuplicateReviewError("DUPLICATE_REVIEW_UNAVAILABLE");
      }
    });
  }
}

async function candidateDetail(tx: Db, row: CandidateRow): Promise<DuplicateCandidateDetail> {
  const base = await readRecords(tx, row.entity_type, row.left_record_id, row.right_record_id);
  if (base.length !== 2) notFound();
  const byId = new Map(base.map((record) => [record.id, record]));
  const left = byId.get(row.left_record_id);
  const right = byId.get(row.right_record_id);
  if (!left || !right) notFound();
  let merge: DuplicateMergeAcknowledgement | null = null;
  if (row.merge_id) {
    merge = await selectMergeAcknowledgement(tx, row.merge_id);
    if (!merge) notFound();
  }
  return Object.freeze({ candidate: toSummary(row), leftProfile: profile(row.entity_type, left),
    rightProfile: profile(row.entity_type, right),
    supportedFields: fields(row.entity_type), merge });
}

async function assertRole(tx: Db, input: { organizationId: string; actorUserId: string; actorRole: string },
  mode: "review" | "merge") {
  if ((mode === "merge" && input.actorRole !== "founder") ||
      (mode === "review" && !["founder","advisor","data_reviewer"].includes(input.actorRole))) forbidden();
  const result = await tx.query<{ role: string }>(
    `SELECT binding.role FROM identity_users AS actor
      JOIN access_organization_memberships AS membership ON membership.user_id=actor.id
       AND membership.organization_id=$1 AND membership.status='active'
      JOIN access_role_bindings AS binding ON binding.membership_id=membership.id
       AND binding.organization_id=$1 AND binding.user_id=actor.id AND binding.status='active'
      JOIN access_organizations AS organization ON organization.id=$1 AND organization.status='active'
     WHERE actor.id=$2 AND actor.status='active' AND binding.role=$3
     FOR SHARE OF actor,membership,binding,organization`,
    [input.organizationId, input.actorUserId, input.actorRole],
  );
  if (result.rows.length !== 1) forbidden();
}

async function canReviewPair(tx: Db, input: { actorRole: string; actorUserId: string },
  entity: DuplicateReviewEntityType, left: string, right: string): Promise<boolean> {
  if (input.actorRole !== "advisor") return true;
  const result = await tx.query<{ count: number | string }>(
    `SELECT count(DISTINCT record_id)::int AS count FROM unnest($1::uuid[]) AS pair(record_id)
      WHERE ${advisorScopeSql(entity, "record_id", 2)}`, [[left, right], input.actorUserId],
  );
  return Number(result.rows[0]?.count) === 2;
}

function advisorScopeSql(entity: DuplicateReviewEntityType, recordExpression: string, actorParameter: number) {
  if (entity === "student") return `EXISTS (SELECT 1 FROM cases_service_cases AS service_case
    WHERE service_case.student_id=${recordExpression} AND service_case.primary_user_id=$${actorParameter}
      AND service_case.primary_role='advisor' AND service_case.stage<>'closed')`;
  return `EXISTS (SELECT 1 FROM crm_student_guardian_relationships AS relationship
    JOIN cases_service_cases AS service_case ON service_case.student_id=relationship.student_id
    WHERE relationship.guardian_id=${recordExpression} AND relationship.ends_at IS NULL
      AND service_case.primary_user_id=$${actorParameter} AND service_case.primary_role='advisor'
      AND service_case.stage<>'closed')`;
}

async function lockRecords(tx: Db, entity: DuplicateReviewEntityType, left: string, right: string) {
  const table = entity === "student" ? "crm_students" : "crm_guardians";
  return (await tx.query<RecordRow>(recordSelect(table, "id=ANY($1::uuid[])", true), [[left, right]])).rows;
}
async function readRecords(tx: Db, entity: DuplicateReviewEntityType, left: string, right: string) {
  const table = entity === "student" ? "crm_students" : "crm_guardians";
  return (await tx.query<RecordRow>(recordSelect(table, "id=ANY($1::uuid[])", false), [[left, right]])).rows;
}
function recordSelect(table: string, condition: string, lock: boolean) {
  const student = table === "crm_students";
  return `SELECT id,display_name,${student ? "date_of_birth::text" : "NULL::text"} AS date_of_birth,
    ${student ? "contact_email" : "NULL::text"} AS contact_email,
    ${student ? "contact_phone" : "NULL::text"} AS contact_phone,
    ${student ? "NULL::text" : "email"} AS email,${student ? "NULL::text" : "phone"} AS phone,
    status,record_version FROM ${table} WHERE ${condition} AND status='active' ORDER BY id${lock ? " FOR UPDATE" : ""}`;
}

function matchingSignals(entity: DuplicateReviewEntityType, left: RecordRow, right: RecordRow) {
  const values: readonly (readonly [DuplicateMatchSignalName, unknown, unknown])[] = [
    ["display_name", normalized(left.display_name), normalized(right.display_name)],
    ...(entity === "student" ? [["date_of_birth", left.date_of_birth, right.date_of_birth] as const] : []),
    ["email", normalized(entity === "student" ? left.contact_email : left.email),
      normalized(entity === "student" ? right.contact_email : right.email)],
    ["phone", digits(entity === "student" ? left.contact_phone : left.phone),
      digits(entity === "student" ? right.contact_phone : right.phone)],
  ];
  return Object.freeze(values.filter(([, a, b]) => a !== null && a === b).map(([name]) => name));
}
function normalized(value: unknown) { return typeof value === "string" && value.trim() ?
  value.trim().toLowerCase().replace(/\s+/g, " ") : null; }
function digits(value: unknown) { if (typeof value !== "string") return null;
  const result = value.replace(/\D/g, ""); return result || null; }
function contactHint(value: string | null) { if (!value) return null;
  if (value.includes("@")) { const [, domain] = value.split("@", 2); return domain ? `***@${domain}` : "***"; }
  const tail = value.replace(/\D/g, "").slice(-4); return tail ? `***${tail}` : "***"; }

async function selectCandidate(tx: Db, id: string, lock: boolean) {
  const result = await tx.query<CandidateRow>(
    `SELECT id,entity_type,left_record_id,right_record_id,left_display_label,right_display_label,
            matching_signals,status,merge_id,record_version FROM crm_duplicate_candidates WHERE id=$1${lock ? " FOR UPDATE" : ""}`,
    [id]); return result.rows[0] ?? null;
}
async function selectMergeAcknowledgement(tx: Db, id: string) {
  const result = await tx.query<MergeRow>(
    `SELECT id,candidate_id,entity_type,source_record_id,canonical_record_id,provenance_revision_id,
            status,correction_id,record_version FROM crm_duplicate_merges WHERE id=$1`, [id]);
  const row = result.rows[0]; return row ? Object.freeze({ id: row.id, sourceRecordId: row.source_record_id,
    canonicalRecordId: row.canonical_record_id, provenanceRevisionId: row.provenance_revision_id,
    status: row.status, recordVersion: version(row.record_version), correctionId: row.correction_id }) : null;
}
async function selectMergeReceipt(tx: Db, id: string) {
  const result = await tx.query<MergeRow>(
    `SELECT id,candidate_id,entity_type,source_record_id,canonical_record_id,provenance_revision_id,
            status,correction_id,record_version FROM crm_duplicate_merges WHERE id=$1`, [id]);
  const row = result.rows[0];
  return row ? Object.freeze({ mergeId: row.id, candidateId: row.candidate_id,
    entityType: row.entity_type, sourceRecordId: row.source_record_id,
    canonicalRecordId: row.canonical_record_id, provenanceRevisionId: row.provenance_revision_id,
    recordVersion: version(row.record_version) }) : null;
}
async function selectCorrection(tx: Db, id: string) {
  const result = await tx.query<{ id:string;merge_id:string;source_record_id:string;canonical_record_id:string;
    restored_alias_target_id:string;record_version:number|string }>(
    `SELECT id,merge_id,source_record_id,canonical_record_id,restored_alias_target_id,record_version
       FROM crm_duplicate_merge_corrections WHERE id=$1`, [id]);
  const row=result.rows[0]; return row ? Object.freeze({ correctiveRevisionId:row.id,mergeId:row.merge_id,
    sourceRecordId:row.source_record_id,canonicalRecordId:row.canonical_record_id,
    restoredAliasTargetId:row.restored_alias_target_id,recordVersion:version(row.record_version) }) : null;
}
async function latestAlias(tx: Db, entity: DuplicateReviewEntityType, source: string, lock=false) {
  const result = await tx.query<{ id:string;merge_id:string;target_record_id:string;revision_number:number|string }>(
    `SELECT id,merge_id,target_record_id,revision_number FROM crm_duplicate_alias_revisions
      WHERE entity_type=$1 AND source_record_id=$2 ORDER BY revision_number DESC LIMIT 1${lock ? " FOR UPDATE" : ""}`,
    [entity,source]); return result.rows[0] ?? null;
}
async function hasActiveAliasInvolvement(tx: Db, entity: DuplicateReviewEntityType,
  recordIds: readonly string[]) {
  const result = await tx.query<{ found: boolean }>(
    `WITH latest AS (
       SELECT DISTINCT ON (source_record_id) source_record_id,target_record_id,merge_id,revision_number
         FROM crm_duplicate_alias_revisions WHERE entity_type=$1
        ORDER BY source_record_id,revision_number DESC
     ) SELECT EXISTS (
       SELECT 1 FROM latest JOIN crm_duplicate_merges AS merge ON merge.id=latest.merge_id
        WHERE merge.status='active' AND latest.target_record_id<>latest.source_record_id
          AND (latest.source_record_id=ANY($2::uuid[]) OR latest.target_record_id=ANY($2::uuid[]))
     ) AS found`, [entity, recordIds]);
  return result.rows[0]?.found === true;
}

async function claimReceipt(tx: Db, input: {organizationId:string;actorUserId:string;idempotencyKey:string;requestHash:string}, operation:string) {
  const claim=await tx.query(`INSERT INTO shared_idempotency_records
    (id,organization_id,actor_user_id,operation,idempotency_key,request_hash,state)
    VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,'in_progress')
    ON CONFLICT (organization_id,actor_user_id,operation,idempotency_key) DO NOTHING RETURNING id`,
    [input.organizationId,input.actorUserId,operation,input.idempotencyKey,input.requestHash]);
  const result=await tx.query<ReceiptRow>(`SELECT request_hash,state,result_reference,response_hash
    FROM shared_idempotency_records WHERE organization_id=$1 AND actor_user_id=$2
    AND operation=$3 AND idempotency_key=$4 FOR UPDATE`,
    [input.organizationId,input.actorUserId,operation,input.idempotencyKey]);
  if(claim.rowCount===1) return null; const row=result.rows[0];
  if(!row || row.request_hash!==input.requestHash) conflict();
  if(row.state!=="completed" || !row.result_reference || !row.response_hash) conflict();
  return {reference:row.result_reference,responseHash:row.response_hash};
}
async function completeReceipt(tx:Db,input:{organizationId:string;actorUserId:string;idempotencyKey:string;requestHash:string},
  operation:string,reference:string,responseHash:string){
  const result=await tx.query(`UPDATE shared_idempotency_records SET state='completed',result_reference=$5,
    response_hash=$6,record_version=record_version+1,updated_at=transaction_timestamp()
    WHERE organization_id=$1 AND actor_user_id=$2 AND operation=$3 AND idempotency_key=$4
    AND request_hash=$7 AND state='in_progress'`,[input.organizationId,input.actorUserId,operation,
    input.idempotencyKey,reference,responseHash,input.requestHash]); if(result.rowCount!==1) unavailable();
}

function toSummary(row:CandidateRow):DuplicateCandidateSummary{return Object.freeze({candidateId:row.id,
  entityType:row.entity_type,leftRecordId:row.left_record_id,rightRecordId:row.right_record_id,
  leftDisplayLabel:row.left_display_label,rightDisplayLabel:row.right_display_label,
  matchingSignals:Object.freeze(row.matching_signals as DuplicateMatchSignalName[]),status:row.status,
  mergeId:row.merge_id,recordVersion:version(row.record_version)});}
function toInitialSummary(row:CandidateRow){return Object.freeze({...toSummary(row),status:"review_required" as const,
  mergeId:null,recordVersion:1});}
function profile(entity:DuplicateReviewEntityType,row:RecordRow):DuplicateProfile{return Object.freeze({id:row.id,
  entityType:entity,displayName:row.display_name,...(entity==="student"?{dateOfBirth:row.date_of_birth,
    contactEmail:row.contact_email,contactPhone:row.contact_phone}:{email:row.email,phone:row.phone}),
  recordVersion:version(row.record_version)});}
function fields(entity:DuplicateReviewEntityType):readonly string[]{return entity==="student"?STUDENT_DUPLICATE_FIELDS:GUARDIAN_DUPLICATE_FIELDS;}
function validateSelections(entity:DuplicateReviewEntityType,selections:readonly DuplicateFieldSelection[],pair:Set<string>){
  const expected=fields(entity);const map=new Map<string,DuplicateFieldSelection>();for(const item of selections){
    if(!item||!expected.includes(item.fieldName)||!pair.has(item.sourceRecordId)||map.has(item.fieldName)) invalid();map.set(item.fieldName,item);}
  if(map.size!==expected.length)invalid();return Object.freeze(expected.map(name=>Object.freeze(map.get(name)!)));}
function candidateHash(value:DuplicateCandidateSummary){return hashRequestPayload({id:value.candidateId,entity_type:value.entityType,
  left_record:{id:value.leftRecordId,display_label:value.leftDisplayLabel},right_record:{id:value.rightRecordId,
  display_label:value.rightDisplayLabel},matching_signals:value.matchingSignals,status:value.status,merge_id:value.mergeId,
  record_version:value.recordVersion});}
function mergeReceiptHash(value:DuplicateMergeReceipt){return hashRequestPayload({merge_id:value.mergeId,
  candidate_id:value.candidateId,entity_type:value.entityType,source_record_id:value.sourceRecordId,
  canonical_record_id:value.canonicalRecordId,provenance_revision_id:value.provenanceRevisionId,
  record_version:value.recordVersion});}
function correctionHash(value:DuplicateCorrectionAcknowledgement){return hashRequestPayload({corrective_revision_id:value.correctiveRevisionId,
  merge_id:value.mergeId,source_record_id:value.sourceRecordId,canonical_record_id:value.canonicalRecordId,
  restored_alias_target_id:value.restoredAliasTargetId,record_version:value.recordVersion});}
function assertResponseHash(actual:string,expected:string){if(actual!==expected)unavailable();}
function required<T>(value:T|undefined):T{if(!value)unavailable();return value;}
function version(value:number|string){const n=typeof value==="number"?value:Number(value);if(!Number.isSafeInteger(n)||n<1)unavailable();return n;}
function isConflictConstraint(cause:unknown){return cause instanceof Error &&
  (cause as Error&{code?:unknown}).code==="23505" && ["crm_duplicate_candidates_pair_key",
    "crm_duplicate_merges_candidate_key","crm_duplicate_corrections_merge_key"].includes(String((cause as Error&{constraint?:unknown}).constraint));}
function forbidden():never{throw new DuplicateReviewError("DUPLICATE_REVIEW_FORBIDDEN");}
function invalid():never{throw new DuplicateReviewError("DUPLICATE_REVIEW_INVALID");}
function notFound():never{throw new DuplicateReviewError("DUPLICATE_REVIEW_NOT_FOUND");}
function stale():never{throw new DuplicateReviewError("DUPLICATE_REVIEW_STALE");}
function conflict():never{throw new DuplicateReviewError("DUPLICATE_REVIEW_CONFLICT");}
function unavailable():never{throw new DuplicateReviewError("DUPLICATE_REVIEW_UNAVAILABLE");}
interface Db{query<Row extends Record<string,unknown>=Record<string,unknown>>(text:string,values?:readonly unknown[]):Promise<{rows:readonly Row[];rowCount:number}>;}
function adapt(tx:TenantTransaction):Db{return Object.freeze({async query<Row extends Record<string,unknown>>(text:string,values?:readonly unknown[]){
  const result=await tx.query<Row>({text,values});return {rows:result.rows,rowCount:result.rowCount??result.rows.length};}});}
