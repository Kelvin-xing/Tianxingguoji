import assert from "node:assert/strict";
import test from "node:test";

import { ApiClientError } from "../../../lib/api/client.ts";
import {
  REFERRAL_SOURCE_TYPES,
  classifyReferralSourceFailure,
  createReferralSource,
  deactivateReferralSource,
  getReferralSource,
  listReferralSources,
  referralSourceCreateFingerprint,
  referralSourceUpdateFingerprint,
  updateReferralSource,
} from "../../../modules/crm/client.ts";

const SOURCE_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_SOURCE_ID = "10000000-0000-4000-8000-000000000002";
const UPDATED_AT = "2026-08-23T00:00:00.000Z";

test("ReferralSource list/detail decode canonical DTOs and request filters", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  let request = 0;
  const sources = [source(SOURCE_ID, "Alpha", "customer_referral", "active", 1),
    source(OTHER_SOURCE_ID, "Beta", "other", "inactive", 2)];
  globalThis.fetch = async (input, init) => {
    request += 1;
    assert.equal(init?.method, "GET");
    assert.equal(input, request === 1 ? "/api/v1/referral-sources?limit=25" :
      request === 2 ? "/api/v1/referral-sources?status=active&limit=25" :
      `/api/v1/referral-sources/${SOURCE_ID}`);
    return apiResponse(request === 1 ? { items: sources, next_cursor: null } :
      request === 2 ? { items: [sources[0]], next_cursor: null } : sources[0]);
  };
  assert.equal((await listReferralSources()).items.length, 2);
  assert.equal((await listReferralSources("active")).items[0]?.status, "active");
  assert.equal((await getReferralSource(SOURCE_ID)).id, SOURCE_ID);
});

test("ReferralSource list rejects PII, invalid enum, order, and over-limit drift", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const valid = source(SOURCE_ID, "Alpha", "customer_referral", "active", 1);
  const invalidLists = [
    { items: [{ ...valid, email: "private@example.invalid" }], next_cursor: null },
    { items: [{ ...valid, source_type: "bank" }], next_cursor: null },
    { items: [{ ...valid, status: "archived" }], next_cursor: null },
    { items: [source(OTHER_SOURCE_ID, "Zulu", "website", "inactive", 1), valid], next_cursor: null },
    { items: Array.from({ length: 101 }, (_, index) => source(syntheticUuid(index), `S${index}`, "event", "active", 1)), next_cursor: null },
  ];
  for (const invalid of invalidLists) {
    globalThis.fetch = async () => apiResponse(invalid);
    await assert.rejects(listReferralSources(), malformedResponse);
  }
});

test("create, update, and deactivate use exact canonical bodies and receipts", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  let request = 0;
  globalThis.fetch = async (input, init) => {
    request += 1;
    assert.equal(new Headers(init?.headers).get("idempotency-key"), `referral-source:test-${request}`);
    if (request === 1) {
      assert.equal(input, "/api/v1/referral-sources");
      assert.equal(init?.method, "POST");
      assert.deepEqual(JSON.parse(String(init.body)), { display_name: "Synthetic Other", source_type: "other", description: "Family referral" });
      return apiResponse(receipt(SOURCE_ID, "active", 1));
    }
    if (request === 2) {
      assert.equal(input, `/api/v1/referral-sources/${SOURCE_ID}`);
      assert.equal(init?.method, "PATCH");
      assert.deepEqual(JSON.parse(String(init.body)), {
        expected_record_version: 1, display_name: "Synthetic Other Updated", source_type: "other",
        description: "Family referral updated",
      });
      return apiResponse(receipt(SOURCE_ID, "active", 2));
    }
    assert.equal(input, `/api/v1/referral-sources/${SOURCE_ID}/deactivate`);
    assert.equal(init?.method, "POST");
    assert.deepEqual(JSON.parse(String(init.body)), { expected_record_version: 2, reason_code: "record.lifecycle.referral_source_deactivated" });
    return apiResponse(receipt(SOURCE_ID, "inactive", 3));
  };
  assert.deepEqual((await createReferralSource({ display_name: "Synthetic Other", source_type: "other", description: "Family referral" }, "referral-source:test-1")).referral_source.status, "active");
  assert.deepEqual((await updateReferralSource(SOURCE_ID, {
    expected_record_version: 1, display_name: "Synthetic Other Updated", source_type: "other", description: "Family referral updated",
  }, "referral-source:test-2")).referral_source.record_version, 2);
  assert.deepEqual((await deactivateReferralSource(SOURCE_ID, {
    expected_record_version: 2, reason_code: "record.lifecycle.referral_source_deactivated",
  }, "referral-source:test-3")).referral_source.status, "inactive");
});

test("ReferralSource write decoder rejects mutable views and wrong receipt", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  for (const invalid of [
    { id: SOURCE_ID, record_version: 1 },
    { referral_source: { id: SOURCE_ID, status: "active", record_version: 1, updated_at: UPDATED_AT, email: "x" } },
    { referral_source: { id: "invalid", status: "active", record_version: 1, updated_at: UPDATED_AT } },
  ]) {
    globalThis.fetch = async () => apiResponse(invalid);
    await assert.rejects(createReferralSource({ display_name: "Alpha", source_type: "website", description: null }, "referral-source:strict"), malformedResponse);
  }
});

test("ReferralSource fingerprints include canonical source fields", () => {
  assert.notEqual(
    referralSourceCreateFingerprint({ display_name: "Alpha", source_type: "website", description: null }),
    referralSourceCreateFingerprint({ display_name: "Beta", source_type: "website", description: null }),
  );
  assert.notEqual(
    referralSourceUpdateFingerprint(SOURCE_ID, { expected_record_version: 1, display_name: "Alpha", source_type: "website", description: null }),
    referralSourceUpdateFingerprint(SOURCE_ID, { expected_record_version: 1, display_name: "Beta", source_type: "website", description: null }),
  );
});

test("ReferralSource failures and canonical enum remain fail closed", () => {
  assert.deepEqual([...REFERRAL_SOURCE_TYPES], ["customer_referral", "employee_referral", "school_referral", "partner_referral", "website", "social_media", "paid_advertising", "event", "walk_in", "other", "unknown"]);
  assert.equal(classifyReferralSourceFailure(apiError("FORBIDDEN", 403)), "forbidden");
  assert.equal(classifyReferralSourceFailure(apiError("NOT_FOUND", 404)), "not_found");
  assert.equal(classifyReferralSourceFailure(apiError("STALE_VERSION", 409)), "stale");
  assert.equal(classifyReferralSourceFailure(new Error("private details")), "unavailable");
});

function source(id: string, displayName: string, type: (typeof REFERRAL_SOURCE_TYPES)[number], status: "active" | "inactive", version: number) {
  return { id, display_name: displayName, source_type: type, description: type === "other" ? "Historical" : null, status, record_version: version, updated_at: UPDATED_AT };
}
function receipt(id: string, status: "active" | "inactive", recordVersion: number) {
  return { referral_source: { id, status, record_version: recordVersion, updated_at: UPDATED_AT } };
}
function syntheticUuid(index: number): string { return `20000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`; }
function apiResponse(data: unknown): Response { return Response.json({ api_version: "v1", request_id: "referral-source-test", data }, { headers: { "x-request-id": "referral-source-test" } }); }
function malformedResponse(error: unknown): boolean { return error instanceof ApiClientError && error.code === "MALFORMED_RESPONSE"; }
function apiError(code: string, status: number): ApiClientError { return new ApiClientError({ code, status, retryable: false, requestId: "referral-source-test" }); }
