import assert from "node:assert/strict";
import test from "node:test";

import {
  candidateData,
  correctionData,
  detailData,
  mergeData,
  mergeReceiptData,
  parseCandidateCreate,
  parseCandidateQuery,
  parseCorrectionCreate,
  parseMergeCreate,
  parseRecordSearch,
  searchItemData,
} from "../../app/api/v1/crm/duplicate-handler.ts";

const LEFT = "51000000-0000-4000-8000-000000000601";
const RIGHT = "51000000-0000-4000-8000-000000000602";
const CANDIDATE = "71000000-0000-4000-8000-000000000001";
const MERGE = "71000000-0000-4000-8000-000000000002";
const REVISION = "71000000-0000-4000-8000-000000000003";

test("parses the frozen search, list, candidate, merge and correction requests", async () => {
  assert.deepEqual(await parseRecordSearch(json({ entity_type: "student", query: "  Synthetic  " })), {
    entityType: "student", query: "Synthetic",
  });
  assert.deepEqual(parseCandidateQuery(new Request(
    "http://local/api/v1/crm/duplicate-candidates?entity_type=guardian&status=merged",
  )), { entityType: "guardian", status: "merged" });
  assert.deepEqual(await parseCandidateCreate(json({ entity_type: "student", left_record_id: LEFT,
    right_record_id: RIGHT }, true), "request-1"), { entityType: "student", leftRecordId: LEFT,
    rightRecordId: RIGHT, requestId: "request-1", idempotencyKey: "crm04-key" });
  const merge = await parseMergeCreate(json({ source_record_id: LEFT, canonical_record_id: RIGHT,
    expected_candidate_record_version: 1, expected_source_record_version: 2,
    expected_canonical_record_version: 3, field_selections: studentFieldSelections(),
    reason_code: "duplicate.confirmed" }, true), CANDIDATE, "request-2");
  assert.equal(merge.fieldSelections.length, 4);
  assert.deepEqual(await parseCorrectionCreate(json({ expected_merge_record_version: 1,
    reason_code: "duplicate.merge.corrected" }, true), MERGE, "request-3"), {
    mergeId: MERGE, expectedMergeRecordVersion: 1, reasonCode: "duplicate.merge.corrected",
    requestId: "request-3", idempotencyKey: "crm04-key",
  });
});

test("rejects unknown fields, browser-authored signals, PII URL query and invalid reason codes", async () => {
  await rejects(parseRecordSearch(json({ entity_type: "student", query: "Synthetic", email: "x" })));
  await rejects(parseCandidateCreate(json({ entity_type: "student", left_record_id: LEFT,
    right_record_id: RIGHT, matching_signals: ["email"] }, true), "request"));
  await rejects(parseMergeCreate(json({ source_record_id: LEFT, canonical_record_id: RIGHT,
    expected_candidate_record_version: 1, expected_source_record_version: 1,
    expected_canonical_record_version: 1, field_selections: studentFieldSelections(), reason_code: "other" }, true),
  CANDIDATE, "request"));
  assert.throws(() => parseCandidateQuery(new Request(
    "http://local/api/v1/crm/duplicate-candidates?entity_type=student&status=merged&query=private",
  )));
});

test("serializes every ADR-DTO-002 response with exact keys", () => {
  const candidate = { candidateId: CANDIDATE, entityType: "student" as const, leftRecordId: LEFT,
    rightRecordId: RIGHT, leftDisplayLabel: "Left", rightDisplayLabel: "Right",
    matchingSignals: ["display_name" as const], status: "review_required" as const,
    mergeId: null, recordVersion: 1 };
  assert.deepEqual(Object.keys(candidateData(candidate)).sort(), ["entity_type", "id", "left_record", "matching_signals",
    "merge_id", "record_version", "right_record", "status"]);
  assert.deepEqual(Object.keys(searchItemData({ id: LEFT, entityType: "student", displayLabel: "Label",
    contactHint: null })).sort(), ["contact_hint", "display_label", "entity_type", "id"]);
  const merge = { id: MERGE, sourceRecordId: LEFT, canonicalRecordId: RIGHT,
    provenanceRevisionId: REVISION, status: "active" as const, recordVersion: 1, correctionId: null };
  assert.deepEqual(Object.keys(mergeData(merge)).sort(), ["canonical_record_id", "correction_id", "id",
    "provenance_revision_id", "record_version", "source_record_id", "status"]);
  assert.deepEqual(mergeReceiptData({ mergeId: MERGE, candidateId: CANDIDATE, entityType: "student",
    sourceRecordId: LEFT, canonicalRecordId: RIGHT, provenanceRevisionId: REVISION, recordVersion: 1 }), {
    merge_id: MERGE,
    candidate_id: CANDIDATE,
    entity_type: "student",
    source_record_id: LEFT,
    canonical_record_id: RIGHT,
    provenance_revision_id: REVISION,
    record_version: 1,
  });
  assert.deepEqual(Object.keys(mergeReceiptData({ mergeId: MERGE, candidateId: CANDIDATE,
    entityType: "student", sourceRecordId: LEFT, canonicalRecordId: RIGHT,
    provenanceRevisionId: REVISION, recordVersion: 1 })).sort(), ["candidate_id", "canonical_record_id",
    "entity_type", "merge_id", "provenance_revision_id", "record_version", "source_record_id"]);
  const detail = detailData({ candidate, leftProfile: { id: LEFT, entityType: "student",
    displayName: "Left", dateOfBirth: null, contactEmail: null, contactPhone: null, recordVersion: 1 },
    rightProfile: { id: RIGHT, entityType: "student", displayName: "Right", dateOfBirth: null,
      contactEmail: null, contactPhone: null, recordVersion: 1 },
    supportedFields: ["display_name", "date_of_birth", "contact_email", "contact_phone"], merge });
  assert.deepEqual(Object.keys(detail).sort(), ["candidate", "left_profile", "merge", "right_profile", "supported_fields"]);
  assert.deepEqual(Object.keys(detail.left_profile).sort(), ["contact_email", "contact_phone", "date_of_birth",
    "display_name", "id", "record_version"]);
  assert.equal(detail.left_profile.id, detail.candidate.left_record.id);
  assert.equal(detail.right_profile.id, detail.candidate.right_record.id);
  assert.deepEqual(Object.keys(correctionData({ correctiveRevisionId: REVISION, mergeId: MERGE,
    sourceRecordId: LEFT, canonicalRecordId: RIGHT, restoredAliasTargetId: LEFT, recordVersion: 1 })).sort(),
  ["canonical_record_id", "corrective_revision_id", "merge_id", "record_version",
    "restored_alias_target_id", "source_record_id"]);
});

function studentFieldSelections() { return ["display_name", "date_of_birth", "contact_email", "contact_phone"]
  .map((field_name) => ({ field_name, source_record_id: LEFT })); }
function json(body: unknown, idempotent = false) { return new Request("http://local/api/v1/crm", {
  method: "POST", headers: { "content-type": "application/json", ...(idempotent ?
    { "idempotency-key": "crm04-key" } : {}) }, body: JSON.stringify(body),
}); }
async function rejects(value: Promise<unknown>) { await assert.rejects(value); }
