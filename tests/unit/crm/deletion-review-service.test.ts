import assert from "node:assert/strict";
import test from "node:test";

import {
  DeletionReviewError,
  DeletionReviewService,
  isDeletionReviewError,
  type DeletionReviewRepository,
} from "../../../modules/crm/application/deletion-review-service.ts";
import type { IdentitySessionActor } from "../../../modules/identity/public.ts";

const IDS = Object.freeze({ organization: "51000000-0000-4000-8000-000000000001",
  actor: "51000000-0000-4000-8000-000000000101",
  target: "51000000-0000-4000-8000-000000000601",
  audit: "71000000-0000-4000-8000-000000000001",
  outbox: "71000000-0000-4000-8000-000000000002" });

test("freezes request and review capability enforcement for all five roles", async () => {
  const calls: string[] = []; const service = new DeletionReviewService(repository(calls));
  for (const role of ["founder", "advisor"] as const) {
    await service.requestDeletion({ actor: actor(role), command: command() });
  }
  await service.listDeletionRequests(actor("founder"), null);
  assert.deepEqual(calls, ["request", "request", "list"]);
  for (const role of ["admin", "data_reviewer", "contractor"] as const) {
    await denied(() => service.requestDeletion({ actor: actor(role), command: command() }));
  }
  for (const role of ["admin", "advisor", "data_reviewer", "contractor"] as const) {
    await denied(() => service.listDeletionRequests(actor(role), null));
  }
});

test("hashes the exact command and emits only PII-free lifecycle effects", async () => {
  let captured: Parameters<DeletionReviewRepository["requestDeletion"]>[0] | undefined;
  const ids = [IDS.audit, IDS.outbox];
  const service = new DeletionReviewService(repository([], { async requestDeletion(input) {
    captured = input; return receipt();
  } }), () => ids.shift()!, () => Date.parse("2026-08-23T00:00:00.000Z"));
  await service.requestDeletion({ actor: actor("founder"), command: command() });
  assert.match(captured?.requestHash ?? "", /^[0-9a-f]{64}$/);
  assert.equal(captured?.reasonCode, "record.lifecycle.pending_delete_requested");
  const effects = JSON.stringify(captured?.effects);
  for (const forbidden of ["Student Name", "student@example.invalid", "+85220000000"]) {
    assert.equal(effects.includes(forbidden), false);
  }
  assert.equal(effects.includes("pending_delete"), true);
});

test("stable deletion error guard accepts cross-module Error and rejects unsafe shapes", () => {
  const crossModule = new Error("redacted"); crossModule.name = "DeletionReviewError";
  Object.defineProperty(crossModule, "code", { value: "DELETION_REVIEW_FORBIDDEN" });
  assert.equal(isDeletionReviewError(crossModule), true);
  assert.equal(isDeletionReviewError(crossModule, "DELETION_REVIEW_FORBIDDEN"), true);
  assert.equal(isDeletionReviewError(crossModule, "DELETION_REVIEW_INVALID"), false);
  assert.equal(isDeletionReviewError({ name: "DeletionReviewError", code: "DELETION_REVIEW_FORBIDDEN" }), false);
  const unknown = new Error("redacted"); unknown.name = "DeletionReviewError";
  Object.defineProperty(unknown, "code", { value: "UNKNOWN" });
  assert.equal(isDeletionReviewError(unknown), false);
});

function repository(calls: string[], overrides: Partial<DeletionReviewRepository> = {}): DeletionReviewRepository {
  return { async requestDeletion() { calls.push("request"); return receipt(); },
    async listDeletionRequests() { calls.push("list"); return []; }, ...overrides };
}
function actor(role: IdentitySessionActor["role"]): IdentitySessionActor { return Object.freeze({
  userId: IDS.actor, organizationId: IDS.organization, role, sessionId: "session", capturedSessionVersion: 1,
  reauthenticatedAtMs: null }); }
function command() { return { entityType: "student" as const, entityId: IDS.target,
  expectedRecordVersion: 1, reasonCode: "record.lifecycle.pending_delete_requested" as const,
  requestId: "crm05-request", idempotencyKey: "crm05-request" }; }
function receipt() { return Object.freeze({ entityType: "student" as const, entityId: IDS.target,
  status: "pending_delete" as const, deletionRequestedAt: "2026-08-23T00:00:00.000Z", recordVersion: 2 }); }
async function denied(action: () => Promise<unknown>) { await assert.rejects(async () => action(),
  (error: unknown) => error instanceof DeletionReviewError && error.code === "DELETION_REVIEW_FORBIDDEN"); }
