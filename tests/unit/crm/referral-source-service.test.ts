import assert from "node:assert/strict";
import test from "node:test";

import { mergeWorkspaceCapabilities, type Release1OrganizationRole, type RequestAccessActor } from "../../../modules/access/public.ts";
import { ReferralSourceError, ReferralSourceService, isReferralSourceError, type ReferralSourceRepository } from "../../../modules/crm/application/referral-source-service.ts";
import { REFERRAL_SOURCE_TYPES } from "../../../modules/crm/domain/referral-source-contract.ts";
import { decodeReferralSourceCursor } from "../../../modules/crm/domain/referral-source-cursor.ts";

const IDS = Object.freeze({
  organization: "51000000-0000-4000-8000-000000000001",
  actor: "51000000-0000-4000-8000-000000000101",
  source: "61000000-0000-4000-8000-000000000001",
  audit: "71000000-0000-4000-8000-000000000001",
  outbox: "71000000-0000-4000-8000-000000000002",
  idem: "71000000-0000-4000-8000-000000000003",
});
const UPDATED_AT = "2026-08-23T00:00:00.000Z";

test("Founder and Advisor read; only Founder manages, with capability union", async () => {
  const calls: string[] = [];
  const service = new ReferralSourceService(repository(calls));
  assert.deepEqual((await service.list(actor(["founder"]), { limit: 25 })).items, []);
  assert.deepEqual((await service.list(actor(["advisor"]), { status: "inactive", limit: 25 })).items, []);
  await service.create({ actor: actor(["founder", "admin"]), command: createCommand() });
  assert.deepEqual(calls, ["list", "list", "create"]);
  assert.throws(() => service.list(actor(["admin"]), null), isError("REFERRAL_SOURCE_FORBIDDEN"));
  assert.throws(() => service.list(actor(["contractor"]), null), isError("REFERRAL_SOURCE_FORBIDDEN"));
  assert.throws(() => service.create({ actor: actor(["advisor"]), command: createCommand() }), isError("REFERRAL_SOURCE_FORBIDDEN"));
});

test("canonical create validates eleven types and other description", async () => {
  const service = new ReferralSourceService(repository([]), idFactory(), () => Date.parse(UPDATED_AT));
  for (const sourceType of REFERRAL_SOURCE_TYPES) {
    await service.create({ actor: actor(["founder"]), command: {
      ...createCommand(), sourceType, description: sourceType === "other" ? "Partner note" : null,
    } });
  }
  assert.throws(() => service.create({ actor: actor(["founder"]), command: { ...createCommand(), sourceType: "other", description: null } }), isError("REFERRAL_SOURCE_INVALID"));
  assert.throws(() => service.create({ actor: actor(["founder"]), command: { ...createCommand(), sourceType: "website", description: "not allowed" } }), isError("REFERRAL_SOURCE_INVALID"));
});

test("create builds PII-free effects and complete acknowledgement", async () => {
  let captured: Parameters<ReferralSourceRepository["create"]>[0] | undefined;
  const service = new ReferralSourceService(repository([], {
    async create(input) { captured = input; return { id: input.sourceId, status: "active", recordVersion: 1, updatedAt: UPDATED_AT }; },
  }), idFactory(), () => Date.parse(UPDATED_AT));
  const result = await service.create({ actor: actor(["founder"]), command: { ...createCommand(), displayName: "  Synthetic Website  " } });
  assert.deepEqual(result, { id: IDS.source, status: "active", recordVersion: 1, updatedAt: UPDATED_AT });
  assert.equal(captured?.displayName, "Synthetic Website");
  assert.equal(JSON.stringify(captured?.effects).includes("Synthetic Website"), false);
  assert.equal(captured?.effects.audit.occurredAt, captured?.effects.outbox.createdAt);
});

test("list cursor/filter validation and stable errors", async () => {
  const service = new ReferralSourceService(repository([]));
  assert.throws(() => service.list(actor(["founder"]), { limit: 101 }), isError("REFERRAL_SOURCE_INVALID"));
  assert.throws(() => service.list(actor(["founder"]), { cursor: "invalid" }), isError("REFERRAL_SOURCE_INVALID"));
  const crossModule = new Error("redacted"); crossModule.name = "ReferralSourceError";
  Object.defineProperty(crossModule, "code", { value: "REFERRAL_SOURCE_FORBIDDEN" });
  assert.equal(isReferralSourceError(crossModule), true);
  assert.equal(isReferralSourceError({ name: "ReferralSourceError", code: "REFERRAL_SOURCE_FORBIDDEN" }), false);
});

test("list emits an opaque filter-bound cursor and rejects reuse under another filter", async () => {
  const service = new ReferralSourceService(repository([], {
    async list() { return { items: [view("Alpha", IDS.source), view("Beta", "61000000-0000-4000-8000-000000000002")], hasMore: true }; },
  }));
  const result = await service.list(actor(["founder"]), { query: "a", status: "active", sourceType: "website", limit: 2 });
  assert.equal(typeof result.nextCursor, "string");
  assert.equal(decodeReferralSourceCursor(result.nextCursor!).displayName, "Beta");
  assert.throws(() => service.list(actor(["founder"]), { query: "different", cursor: result.nextCursor }), isError("REFERRAL_SOURCE_INVALID"));
});

function repository(calls: string[], overrides: Partial<ReferralSourceRepository> = {}): ReferralSourceRepository {
  return {
    async list() { calls.push("list"); return { items: [], hasMore: false }; },
    async find() { return null; },
    async create(input) { calls.push("create"); return { id: input.sourceId, status: "active", recordVersion: 1, updatedAt: UPDATED_AT }; },
    async update(input) { calls.push("update"); return { id: input.sourceId, status: "active", recordVersion: 2, updatedAt: UPDATED_AT }; },
    async deactivate(input) { calls.push("deactivate"); return { id: input.sourceId, status: "inactive", recordVersion: 2, updatedAt: UPDATED_AT }; },
    ...overrides,
  };
}

function actor(roles: readonly Release1OrganizationRole[]): RequestAccessActor {
  return Object.freeze({ userId: IDS.actor, organizationId: IDS.organization, roles, workspaceCapabilities: mergeWorkspaceCapabilities(roles) });
}
function createCommand() {
  return { displayName: "Synthetic Source", sourceType: "website" as const, description: null,
    requestId: "crm06-request", idempotencyKey: "crm06-request" };
}
function idFactory() {
  const values = [IDS.source, IDS.idem, IDS.audit, IDS.outbox, "61000000-0000-4000-8000-000000000002"];
  return () => values.shift() ?? IDS.source;
}
function isError(code: ReferralSourceError["code"]) {
  return (error: unknown): boolean => error instanceof ReferralSourceError && error.code === code;
}
function view(displayName: string, id: string) {
  return { id, displayName, sourceType: "website" as const, description: null, status: "active" as const, recordVersion: 1, updatedAt: UPDATED_AT };
}
