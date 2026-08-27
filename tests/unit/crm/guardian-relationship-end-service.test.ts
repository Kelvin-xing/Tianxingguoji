import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { workspaceCapabilitiesForRole, type RequestAccessActor } from "../../../modules/access/public.ts";
import {
  GuardianRelationshipError,
  GuardianRelationshipService,
  type GuardianRelationshipRepository,
} from "../../../modules/crm/application/guardian-relationship-service.ts";

const ORG = "10000000-0000-4000-8000-000000000001";
const USER = "10000000-0000-4000-8000-000000000002";
const STUDENT = "10000000-0000-4000-8000-000000000003";
const REL = "10000000-0000-4000-8000-000000000004";
const IDS = ["10000000-0000-4000-8000-000000000010", "10000000-0000-4000-8000-000000000011", "10000000-0000-4000-8000-000000000012"];

function actor(role: "founder" | "advisor" | "admin" | "contractor"): RequestAccessActor {
  return { userId: USER, organizationId: ORG, roles: [role], workspaceCapabilities: workspaceCapabilitiesForRole(role) };
}

function command() {
  return { studentId: STUDENT, relationshipId: REL, expectedRecordVersion: 4, requestId: "req-end-1", idempotencyKey: "end-key-1" };
}

function repository(capture: (input: Parameters<GuardianRelationshipRepository["endRelationship"]>[0]) => void): GuardianRelationshipRepository {
  const unsupported = async (): Promise<never> => { throw new GuardianRelationshipError("GUARDIAN_RELATIONSHIP_UNAVAILABLE"); };
  return {
    listCurrent: unsupported, listHistory: unsupported, searchGuardians: unsupported,
    createRelationship: unsupported, handoffPrimaryContact: unsupported,
    endRelationship: async (input) => {
      capture(input);
      return { relationshipId: REL, studentId: STUDENT, status: "ended", endsAt: "2026-08-26T00:00:00.000Z", recordVersion: 5, occurredAt: "2026-08-26T00:00:00.000Z" };
    },
  };
}

test("Founder and Advisor end through capability and emit bounded effects", async () => {
  for (const role of ["founder", "advisor"] as const) {
    let captured: Parameters<GuardianRelationshipRepository["endRelationship"]>[0] | undefined;
    const service = new GuardianRelationshipService(repository((input) => { captured = input; }), randomUUID, () => Date.parse("2026-08-26T00:00:00.000Z"));
    const result = await service.endRelationship({ actor: actor(role), command: command() });
    assert.equal(result.status, "ended");
    assert.equal(result.endsAt, result.occurredAt);
    assert.equal(captured?.reason, "guardian.relationship.ended");
    assert.equal(captured?.requestHash.length, 64);
    assert.equal(new Set([captured?.idempotencyRecordId, captured?.effects.audit.id, captured?.effects.outbox.id]).size, 3);
    assert.deepEqual(captured?.effects.audit.metadata, { status: "ended", previous_version: 4, next_version: 5, reason_code: "guardian.relationship.ended", request_id: "req-end-1" });
    assert.deepEqual(captured?.effects.outbox.payload, { aggregate_id: REL, status: "ended", previous_record_version: 4, record_version: 5, reason_code: "guardian.relationship.ended", request_id: "req-end-1" });
    const serialized = JSON.stringify(captured?.effects);
    assert.doesNotMatch(serialized, /display_name|email|phone|guardian_name/i);
    assert.match(serialized, /crm\.guardian_relationship_ended/);
  }
});

test("missing capability and invalid commands fail closed", async () => {
  const service = new GuardianRelationshipService(repository(() => undefined));
  await assert.rejects(() => service.endRelationship({ actor: actor("admin"), command: command() }), (error: unknown) => error instanceof GuardianRelationshipError && error.code === "GUARDIAN_RELATIONSHIP_FORBIDDEN");
  await assert.rejects(() => service.endRelationship({ actor: actor("founder"), command: { ...command(), relationshipId: "bad" } }), (error: unknown) => error instanceof GuardianRelationshipError && error.code === "GUARDIAN_RELATIONSHIP_INVALID");
  await assert.rejects(() => service.endRelationship({ actor: actor("founder"), command: { ...command(), expectedRecordVersion: 0 } }), (error: unknown) => error instanceof GuardianRelationshipError && error.code === "GUARDIAN_RELATIONSHIP_INVALID");
  await assert.rejects(() => service.endRelationship({ actor: actor("founder"), command: { ...command(), studentId: "bad" } }), (error: unknown) => error instanceof GuardianRelationshipError && error.code === "GUARDIAN_RELATIONSHIP_INVALID");
  await assert.rejects(() => service.endRelationship({ actor: actor("founder"), command: { ...command(), requestId: "" } }), (error: unknown) => error instanceof GuardianRelationshipError && error.code === "GUARDIAN_RELATIONSHIP_INVALID");
  await assert.rejects(() => service.endRelationship({ actor: actor("founder"), command: { ...command(), idempotencyKey: "" } }), (error: unknown) => error instanceof GuardianRelationshipError && error.code === "GUARDIAN_RELATIONSHIP_INVALID");
});
