import assert from "node:assert/strict";
import test from "node:test";

import type { MutationEffectBundle } from "../../../modules/audit/public.ts";
import {
  DuplicateReviewError,
  type DuplicateReviewRepository,
} from "../../../modules/crm/application/duplicate-review-service.ts";
import { PostgresqlDuplicateReviewRepository } from
  "../../../modules/crm/infrastructure/postgresql-duplicate-review-repository.ts";
import { hashRequestPayload } from "../../../modules/shared/public.ts";
import type { TenantDatabaseContext, TenantTransaction, TenantTransactionRunner } from
  "../../../modules/shared/server.ts";

const IDS = Object.freeze({
  organization: "51000000-0000-4000-8000-000000000001",
  actor: "51000000-0000-4000-8000-000000000101",
  candidate: "71000000-0000-4000-8000-000000000001",
  merge: "71000000-0000-4000-8000-000000000002",
  source: "51000000-0000-4000-8000-000000000601",
  canonical: "51000000-0000-4000-8000-000000000602",
  provenance: "71000000-0000-4000-8000-000000000003",
});
const REQUEST_HASH = "a".repeat(64);

test("keeps candidate detail profiles bound to the preserved pair before, during and after merge", async () => {
  for (const merge of [null, mergeRow("active", 1, null), mergeRow("corrected", 2,
    "71000000-0000-4000-8000-000000000004")] as const) {
    const repository = new PostgresqlDuplicateReviewRepository(runner(async (text) => {
      if (text.includes("SELECT binding.role FROM identity_users")) return result([{ role: "founder" }]);
      if (text.includes("FROM crm_duplicate_candidates WHERE id=$1")) return result([candidateRow(merge?.id ?? null)]);
      if (text.includes("FROM crm_students WHERE id=ANY")) return result([
        studentRow(IDS.canonical, "Right current columns", 4),
        studentRow(IDS.source, "Left current columns", 3),
      ]);
      if (text.includes("FROM crm_duplicate_merges WHERE id=$1") && merge) return result([merge]);
      throw new Error("unexpected query");
    }));
    const detail = await repository.findCandidate({ organizationId: IDS.organization,
      actorUserId: IDS.actor, actorRole: "founder", candidateId: IDS.candidate });
    assert.equal(detail?.candidate.leftRecordId, IDS.source);
    assert.equal(detail?.candidate.rightRecordId, IDS.canonical);
    assert.equal(detail?.leftProfile.id, IDS.source);
    assert.equal(detail?.leftProfile.displayName, "Left current columns");
    assert.equal(detail?.rightProfile.id, IDS.canonical);
    assert.equal(detail?.rightProfile.displayName, "Right current columns");
    assert.equal(detail?.merge?.status ?? null, merge?.status ?? null);
  }
});

test("replays the exact POST receipt using authoritative candidate and entity fields from PostgreSQL", async () => {
  const repository = repositoryForReplay(receiptHash());
  const receipt = await repository.mergeCandidate(input());
  assert.deepEqual(receipt, {
    mergeId: IDS.merge,
    candidateId: IDS.candidate,
    entityType: "student",
    sourceRecordId: IDS.source,
    canonicalRecordId: IDS.canonical,
    provenanceRevisionId: IDS.provenance,
    recordVersion: 1,
  });
  assert.equal(JSON.stringify(receipt).includes("display_name"), false);
  assert.equal(JSON.stringify(receipt).includes("status"), false);
  assert.equal(JSON.stringify(receipt).includes("correction"), false);
});

test("fails closed when the stored merge receipt hash is not the exact seven-field acknowledgement hash", async () => {
  await assert.rejects(repositoryForReplay("b".repeat(64)).mergeCandidate(input()),
    (error: unknown) => error instanceof DuplicateReviewError &&
      error.code === "DUPLICATE_REVIEW_UNAVAILABLE");
});

function repositoryForReplay(responseHash: string) {
  return new PostgresqlDuplicateReviewRepository(runner(async (text) => {
    if (text.includes("INSERT INTO shared_idempotency_records")) return result([], 0);
    if (text.includes("SELECT request_hash,state,result_reference,response_hash")) return result([{
      request_hash: REQUEST_HASH, state: "completed", result_reference: IDS.merge,
      response_hash: responseHash,
    }]);
    if (text.includes("SELECT binding.role FROM identity_users")) return result([{ role: "founder" }]);
    if (text.includes("FROM crm_duplicate_merges WHERE id=$1")) return result([{
      id: IDS.merge, candidate_id: IDS.candidate, entity_type: "student",
      source_record_id: IDS.source, canonical_record_id: IDS.canonical,
      provenance_revision_id: IDS.provenance, status: "corrected",
      correction_id: "71000000-0000-4000-8000-000000000004", record_version: 2,
    }]);
    throw new Error("unexpected query");
  }));
}

function input(): Parameters<DuplicateReviewRepository["mergeCandidate"]>[0] {
  return { organizationId: IDS.organization, actorUserId: IDS.actor, actorRole: "founder",
    mergeId: IDS.merge, aliasRevisionId: "71000000-0000-4000-8000-000000000005",
    provenanceRevisionId: IDS.provenance, candidateId: IDS.candidate,
    sourceRecordId: IDS.source, canonicalRecordId: IDS.canonical,
    expectedCandidateRecordVersion: 1, expectedSourceRecordVersion: 1,
    expectedCanonicalRecordVersion: 1, fieldSelections: [], reasonCode: "duplicate.confirmed",
    idempotencyKey: "crm04-merge", requestHash: REQUEST_HASH, effects: {} as MutationEffectBundle };
}

function receiptHash() {
  return hashRequestPayload({ merge_id: IDS.merge, candidate_id: IDS.candidate,
    entity_type: "student", source_record_id: IDS.source, canonical_record_id: IDS.canonical,
    provenance_revision_id: IDS.provenance, record_version: 1 });
}

function candidateRow(mergeId: string | null) {
  return { id: IDS.candidate, entity_type: "student", left_record_id: IDS.source,
    right_record_id: IDS.canonical, left_display_label: "Left", right_display_label: "Right",
    matching_signals: ["email"], status: mergeId ? "merged" : "review_required",
    merge_id: mergeId, record_version: mergeId ? 2 : 1 };
}

function mergeRow(status: "active" | "corrected", recordVersion: number, correctionId: string | null) {
  return { id: IDS.merge, candidate_id: IDS.candidate, entity_type: "student",
    source_record_id: IDS.source, canonical_record_id: IDS.canonical,
    provenance_revision_id: IDS.provenance, status, correction_id: correctionId,
    record_version: recordVersion };
}

function studentRow(id: string, displayName: string, recordVersion: number) {
  return { id, display_name: displayName, date_of_birth: null, contact_email: null,
    contact_phone: null, email: null, phone: null, status: "active", record_version: recordVersion };
}

function runner(execute: (text: string, values?: readonly unknown[]) => Promise<unknown> | unknown):
TenantTransactionRunner {
  return Object.freeze({ async run<Result>(_context: TenantDatabaseContext,
    operation: (transaction: TenantTransaction) => Promise<Result>): Promise<Result> {
    return operation({ query: ({ text, values }) => execute(text, values) as never });
  } });
}

function result(rows: readonly Record<string, unknown>[], rowCount = rows.length) {
  return Object.freeze({ rows, rowCount });
}
