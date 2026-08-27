import assert from "node:assert/strict";
import test from "node:test";

import { acknowledgementData, mapReferralSourceError, parseReferralSourceCreate,
  parseReferralSourceDeactivate, parseReferralSourceListFilter, parseReferralSourceUpdate, sourceData } from
  "../../app/api/v1/referral-sources/handler.ts";
import { assignmentAcknowledgementData, assignmentData, assignmentsData,
  mapCaseReferralSourceError, parseCaseReferralSourceAssignment } from
  "../../app/api/v1/cases/[caseId]/referral-source-assignments/handler.ts";

const CASE_ID = "61000000-0000-4000-8000-000000000001";
const SOURCE_ID = "61000000-0000-4000-8000-000000000002";

test("CRM-06 source handlers freeze strict request and exact response DTOs", async () => {
  assert.deepEqual(parseReferralSourceListFilter(new Request("http://localhost/api/v1/referral-sources")),
    { query: null, status: null, sourceType: null, limit: 25, cursor: null });
  assert.equal(parseReferralSourceListFilter(new Request("http://localhost/api/v1/referral-sources?status=active")).status, "active");
  assert.throws(() => parseReferralSourceListFilter(new Request("http://localhost/api/v1/referral-sources?status=active&status=inactive")));
  assert.equal(parseReferralSourceListFilter(new Request("http://localhost/api/v1/referral-sources?q=x")).query, "x");
  const created = await parseReferralSourceCreate(jsonRequest("/api/v1/referral-sources",
    { display_name: "Synthetic Website", source_type: "website", description: null }), "request-id");
  assert.deepEqual(Object.keys(created).sort(), ["description","displayName","idempotencyKey","requestId","sourceType"].sort());
  await assert.rejects(() => parseReferralSourceCreate(jsonRequest("/api/v1/referral-sources",
    { display_name: "Synthetic Website", source_type: "website", description: null, status: "active" }), "request-id"));
  const updated = await parseReferralSourceUpdate(jsonRequest(`/api/v1/referral-sources/${SOURCE_ID}`,
    { expected_record_version: 1, display_name: "Updated", source_type: "website", description: null }, "PATCH"),
  SOURCE_ID, "request-id");
  assert.equal(updated.sourceType, "website");
  await assert.rejects(() => parseReferralSourceUpdate(jsonRequest(`/api/v1/referral-sources/${SOURCE_ID}`,
    { expected_record_version: 1, display_name: "Updated", source_type: "website", description: null, status: "active" }, "PATCH"),
  SOURCE_ID, "request-id"));
  assert.deepEqual(Object.keys(sourceData({ id: SOURCE_ID, displayName: "Synthetic Website", sourceType: "website",
    description: null, status: "active", recordVersion: 1, updatedAt: "2026-08-23T00:00:00.000Z" }) as object).sort(),
    ["description","display_name","id","record_version","source_type","status","updated_at"]);
  assert.deepEqual(acknowledgementData({ id: SOURCE_ID, status: "active", recordVersion: 2, updatedAt: "2026-08-23T00:00:00.000Z" }),
    { referral_source: { id: SOURCE_ID, status: "active", record_version: 2, updated_at: "2026-08-23T00:00:00.000Z" } });
  const deactivate = await parseReferralSourceDeactivate(jsonRequest(`/api/v1/referral-sources/${SOURCE_ID}/deactivate`,
    { expected_record_version: 2, reason_code: "record.lifecycle.referral_source_deactivated" }), SOURCE_ID, "request-id");
  assert.equal(deactivate.expectedRecordVersion, 2);
});

test("CRM-06 assignment handlers freeze strict command, GET views, and two-key receipt", async () => {
  const command = await parseCaseReferralSourceAssignment(jsonRequest(
    `/api/v1/cases/${CASE_ID}/referral-source-assignments`,
    { referral_source_id: SOURCE_ID, expected_current_assignment_record_version: null }), CASE_ID, "request-id");
  assert.deepEqual(Object.keys(command).sort(), ["caseId","expectedCurrentAssignmentRecordVersion",
    "idempotencyKey","referralSourceId","requestId"].sort());
  await assert.rejects(() => parseCaseReferralSourceAssignment(jsonRequest(
    `/api/v1/cases/${CASE_ID}/referral-source-assignments`,
    { referral_source_id: SOURCE_ID, expected_current_assignment_record_version: null, role: "founder" }),
  CASE_ID, "request-id"));
  const item = { id: "61000000-0000-4000-8000-000000000003", referralSourceId: SOURCE_ID,
    sourceDisplayName: "Synthetic Website", sourceType: "website" as const, sourceRecordVersion: 1,
    startsAt: "2026-08-23T00:00:00.000Z", endsAt: null, recordVersion: 1 };
  assert.deepEqual(Object.keys(assignmentData(item) as object).sort(), ["ends_at","id","record_version",
    "referral_source_id","source_display_name","source_record_version","source_type","starts_at"]);
  assert.deepEqual(Object.keys(assignmentsData({ current: item, history: [] }) as object).sort(), ["current","history"]);
  assert.deepEqual(assignmentAcknowledgementData({ id: item.id, recordVersion: 1 }),
    { id: item.id, record_version: 1 });
});

test("CRM-06 route error mapping accepts stable Error identity and rejects unsafe lookalikes", () => {
  const source = new Error("redacted"); source.name = "ReferralSourceError";
  Object.defineProperty(source, "code", { value: "REFERRAL_SOURCE_FORBIDDEN" });
  assert.equal((mapReferralSourceError(source) as { code: string }).code, "FORBIDDEN");
  const assignment = new Error("redacted"); assignment.name = "CaseReferralSourceError";
  Object.defineProperty(assignment, "code", { value: "CASE_REFERRAL_SOURCE_STALE" });
  assert.equal((mapCaseReferralSourceError(assignment) as { code: string }).code, "STALE_VERSION");
  const plain = { name: "ReferralSourceError", code: "REFERRAL_SOURCE_FORBIDDEN" };
  assert.equal(mapReferralSourceError(plain), plain);
});

function jsonRequest(path: string, body: unknown, method = "POST") {
  return new Request(`http://localhost${path}`, { method, headers: { "content-type": "application/json",
    "idempotency-key": "crm06-key" }, body: JSON.stringify(body) });
}
