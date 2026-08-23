import assert from "node:assert/strict";
import test from "node:test";

import { ReferralSourceError, ReferralSourceService, isReferralSourceError,
  type ReferralSourceRepository } from "../../../modules/crm/application/referral-source-service.ts";
import type { IdentitySessionActor } from "../../../modules/identity/public.ts";

const IDS = Object.freeze({ organization: "51000000-0000-4000-8000-000000000001",
  actor: "51000000-0000-4000-8000-000000000101", source: "61000000-0000-4000-8000-000000000001",
  audit: "71000000-0000-4000-8000-000000000001", outbox: "71000000-0000-4000-8000-000000000002" });

test("freezes CRM-06 source read and manage roles", async () => {
  const calls: string[] = []; const service = new ReferralSourceService(repository(calls), ids());
  for (const role of ["founder", "admin", "advisor"] as const) await service.list(actor(role), null);
  for (const role of ["founder", "admin"] as const) await service.create({ actor: actor(role), command: createCommand() });
  assert.deepEqual(calls, ["list","list","list","create","create"]);
  for (const role of ["data_reviewer","contractor"] as const) await forbidden(() => service.list(actor(role), null));
  for (const role of ["advisor","data_reviewer","contractor"] as const) {
    await forbidden(() => service.create({ actor: actor(role), command: createCommand() }));
  }
});

test("normalizes display name and creates PII-free effects with a two-key acknowledgement", async () => {
  let captured: Parameters<ReferralSourceRepository["create"]>[0] | undefined;
  const service = new ReferralSourceService(repository([], { async create(input) { captured = input;
    return { id: input.sourceId, recordVersion: 1 }; } }), ids(), () => Date.parse("2026-08-23T00:00:00Z"));
  const result = await service.create({ actor: actor("founder"), command: {
    ...createCommand(), displayName: "  Synthetic Bank  " } });
  assert.deepEqual(result, { id: IDS.source, recordVersion: 1 });
  assert.equal(captured?.displayName, "Synthetic Bank");
  assert.match(captured?.requestHash ?? "", /^[0-9a-f]{64}$/);
  const effects = JSON.stringify(captured?.effects);
  assert.equal(effects.includes("Synthetic Bank"), false);
  assert.equal(effects.includes("display_name"), false);
});

test("rejects invalid enums, no-op-shaped input bounds, and unsafe error lookalikes", async () => {
  const service = new ReferralSourceService(repository([]), ids());
  assert.throws(() => service.create({ actor: actor("founder"), command: {
    ...createCommand(), sourceType: "school" as never } }), invalidError);
  assert.throws(() => service.create({ actor: actor("founder"), command: {
    ...createCommand(), displayName: "x".repeat(201) } }), invalidError);
  const crossModule = new Error("redacted"); crossModule.name = "ReferralSourceError";
  Object.defineProperty(crossModule, "code", { value: "REFERRAL_SOURCE_FORBIDDEN" });
  assert.equal(isReferralSourceError(crossModule), true);
  assert.equal(isReferralSourceError({ name: "ReferralSourceError", code: "REFERRAL_SOURCE_FORBIDDEN" }), false);
  const unknown = new Error("redacted"); unknown.name = "ReferralSourceError";
  Object.defineProperty(unknown, "code", { value: "UNKNOWN" });
  assert.equal(isReferralSourceError(unknown), false);
});

function repository(calls: string[], overrides: Partial<ReferralSourceRepository> = {}): ReferralSourceRepository {
  return { async list() { calls.push("list"); return []; }, async find() { return null; },
    async create(input) { calls.push("create"); return { id: input.sourceId, recordVersion: 1 }; },
    async update(input) { calls.push("update"); return { id: input.sourceId, recordVersion: 2 }; }, ...overrides };
}
function actor(role: IdentitySessionActor["role"]): IdentitySessionActor { return Object.freeze({
  userId: IDS.actor, organizationId: IDS.organization, role, sessionId: "session",
  capturedSessionVersion: 1, reauthenticatedAtMs: null }); }
function createCommand() { return { displayName: "Synthetic Bank", sourceType: "bank" as const,
  requestId: "crm06-request", idempotencyKey: "crm06-request" }; }
function ids() { const values = [IDS.source,IDS.audit,IDS.outbox,IDS.source,IDS.audit,IDS.outbox];
  return () => values.shift() ?? IDS.source; }
async function forbidden(action: () => Promise<unknown>) { await assert.rejects(() => Promise.resolve().then(action),
  (error: unknown) => error instanceof ReferralSourceError && error.code === "REFERRAL_SOURCE_FORBIDDEN"); }
function invalidError(error: unknown) { return error instanceof ReferralSourceError && error.code === "REFERRAL_SOURCE_INVALID"; }
