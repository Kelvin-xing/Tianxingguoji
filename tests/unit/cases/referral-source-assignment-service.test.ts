import assert from "node:assert/strict";
import test from "node:test";

import { CaseReferralSourceAssignmentService, CaseReferralSourceError, isCaseReferralSourceError,
  type CaseReferralSourceAssignmentRepository } from "../../../modules/cases/application/referral-source-assignment-service.ts";
import type { IdentitySessionActor } from "../../../modules/identity/public.ts";

const IDS = Object.freeze({ organization: "51000000-0000-4000-8000-000000000001",
  actor: "51000000-0000-4000-8000-000000000101", case: "61000000-0000-4000-8000-000000000001",
  source: "61000000-0000-4000-8000-000000000002", assignment: "61000000-0000-4000-8000-000000000003",
  audit: "71000000-0000-4000-8000-000000000001", outbox: "71000000-0000-4000-8000-000000000002" });

test("freezes Founder and Advisor assignment capability independently of case read", async () => {
  const calls: string[] = []; const service = new CaseReferralSourceAssignmentService(repository(calls), ids());
  for (const role of ["founder","advisor"] as const) {
    await service.read(actor(role), IDS.case);
    await service.assign({ actor: actor(role), command: command() });
  }
  assert.deepEqual(calls, ["read","assign","read","assign"]);
  for (const role of ["admin","data_reviewer","contractor"] as const) {
    await forbidden(() => service.read(actor(role), IDS.case));
    await forbidden(() => service.assign({ actor: actor(role), command: command() }));
  }
});

test("hashes only server-authorized assignment command and returns two-key acknowledgement", async () => {
  let captured: Parameters<CaseReferralSourceAssignmentRepository["assign"]>[0] | undefined;
  const service = new CaseReferralSourceAssignmentService(repository([], { async assign(input) { captured = input;
    return { id: input.assignmentId, recordVersion: 1 }; } }), ids(), () => Date.parse("2026-08-23T00:00:00Z"));
  const result = await service.assign({ actor: actor("advisor"), command: command() });
  assert.deepEqual(result, { id: IDS.assignment, recordVersion: 1 });
  assert.match(captured?.requestHash ?? "", /^[0-9a-f]{64}$/);
  const effects = JSON.stringify(captured?.effects);
  assert.equal(effects.includes("display_name"), false);
  assert.equal(effects.includes("source_display_name"), false);
});

test("stable assignment error guard accepts Error identity only and unknown codes fail closed", () => {
  const crossModule = new Error("redacted"); crossModule.name = "CaseReferralSourceError";
  Object.defineProperty(crossModule, "code", { value: "CASE_REFERRAL_SOURCE_STALE" });
  assert.equal(isCaseReferralSourceError(crossModule, "CASE_REFERRAL_SOURCE_STALE"), true);
  assert.equal(isCaseReferralSourceError({ name: "CaseReferralSourceError", code: "CASE_REFERRAL_SOURCE_STALE" }), false);
  const unknown = new Error("redacted"); unknown.name = "CaseReferralSourceError";
  Object.defineProperty(unknown, "code", { value: "UNKNOWN" });
  assert.equal(isCaseReferralSourceError(unknown), false);
});

function repository(calls: string[], overrides: Partial<CaseReferralSourceAssignmentRepository> = {}):
  CaseReferralSourceAssignmentRepository { return { async read() { calls.push("read"); return { current: null, history: [] }; },
    async assign(input) { calls.push("assign"); return { id: input.assignmentId, recordVersion: 1 }; }, ...overrides }; }
function actor(role: IdentitySessionActor["role"]): IdentitySessionActor { return Object.freeze({
  userId: IDS.actor, organizationId: IDS.organization, role, sessionId: "session",
  capturedSessionVersion: 1, reauthenticatedAtMs: null }); }
function command() { return { caseId: IDS.case, referralSourceId: IDS.source,
  expectedCurrentAssignmentRecordVersion: null, requestId: "crm06-request", idempotencyKey: "crm06-request" }; }
function ids() { const values = [IDS.assignment,IDS.audit,IDS.outbox,IDS.assignment,IDS.audit,IDS.outbox];
  return () => values.shift() ?? IDS.assignment; }
async function forbidden(action: () => Promise<unknown>) { await assert.rejects(() => Promise.resolve().then(action),
  (error: unknown) => error instanceof CaseReferralSourceError && error.code === "CASE_REFERRAL_SOURCE_FORBIDDEN"); }
