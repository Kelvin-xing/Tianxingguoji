import assert from "node:assert/strict";
import test from "node:test";
import { assertAuditReadQuery, auditEventVisibleToTrialActor } from "../../../modules/audit/server.ts";

const org = "10000000-0000-4000-8000-000000000001";
const user = "10000000-0000-4000-8000-000000000002";
const principal = (level: "founder" | "l1" | "l2" | "l3") => ({ userId: user, organizationId: org, active: true, level, categories: ["international_school"] as const, recordVersion: 1 });

test("security audit is founder-only and invalid paging fails closed", () => {
  assert.doesNotThrow(() => assertAuditReadQuery({ organizationId: org, actor: { userId: user, organizationId: org, trialPrincipal: principal("founder") }, scope: "security", limit: 50, before: null }));
  assert.throws(() => assertAuditReadQuery({ organizationId: org, actor: { userId: user, organizationId: org, trialPrincipal: principal("l1") }, scope: "security", limit: 50, before: null }));
  assert.throws(() => assertAuditReadQuery({ organizationId: org, actor: { userId: user, organizationId: org, trialPrincipal: principal("l1") }, scope: "business", limit: 101, before: null }));
  assert.throws(() => assertAuditReadQuery({ organizationId: org, actor: { userId: user, organizationId: org, trialPrincipal: { ...principal("founder"), userId: "10000000-0000-4000-8000-000000000003" } }, scope: "business", limit: 50, before: null }));
});

test("L3 sees only task events performed by the current user", () => {
  assert.equal(auditEventVisibleToTrialActor({ level: "l3", actorUserId: user, eventActorUserId: user, eventType: "tasks.changed", scope: "business" }), true);
  assert.equal(auditEventVisibleToTrialActor({ level: "l3", actorUserId: user, eventActorUserId: user, eventType: "documents.changed", scope: "business" }), false);
  assert.equal(auditEventVisibleToTrialActor({ level: "l3", actorUserId: user, eventActorUserId: "10000000-0000-4000-8000-000000000003", eventType: "tasks.changed", scope: "business" }), false);
});
