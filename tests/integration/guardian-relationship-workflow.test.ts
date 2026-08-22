import assert from "node:assert/strict";
import test from "node:test";

import {
  GuardianRelationshipError,
  GuardianRelationshipService,
  type GuardianRelationshipRepository,
} from "../../modules/crm/application/guardian-relationship-service.ts";
import type { IdentitySessionActor } from "../../modules/identity/public.ts";

const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const STUDENT_ID = "44444444-4444-4444-8444-444444444444";
const GUARDIAN_ID = "66666666-6666-4666-8666-666666666666";
const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const IDS = [
  "70000000-0000-4000-8000-000000000001",
  "70000000-0000-4000-8000-000000000002",
  "70000000-0000-4000-8000-000000000003",
  "70000000-0000-4000-8000-000000000004",
  "70000000-0000-4000-8000-000000000005",
  "70000000-0000-4000-8000-000000000006",
];

test("Advisor-only management fixes attach primary=false and handoff reason server-side", async () => {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  const repository = repositoryStub(calls);
  let index = 0;
  const service = new GuardianRelationshipService(repository, () => IDS[index++]!, () => 1_754_265_600_000);

  const attached = await service.attachGuardian({
    actor: actor("advisor"),
    command: {
      studentId: STUDENT_ID,
      guardianId: GUARDIAN_ID,
      relationshipType: "father",
      isLegalGuardian: true,
      isEmergencyContact: false,
      isBillingContact: false,
      notificationConsent: false,
      requestId: "crm02.attach",
      idempotencyKey: "crm02-attach-1",
    },
  });
  assert.equal(attached.isPrimaryContact, false);
  assert.equal(calls[0]!.input.isPrimaryContact, undefined);
  assert.equal((calls[0]!.input.requestHash as string).length, 64);

  const handedOff = await service.handoffPrimaryContact({
    actor: actor("advisor"),
    command: {
      studentId: STUDENT_ID,
      successorGuardianId: GUARDIAN_ID,
      expectedPrimaryRecordVersion: 1,
      requestId: "crm02.handoff",
      idempotencyKey: "crm02-handoff-1",
    },
  });
  assert.equal(handedOff.relationship.isPrimaryContact, true);
  assert.equal(calls[1]!.input.reason, "guardian.primary.handoff");
});

test("Founder, Admin, Data Reviewer and Contractor cannot manage Guardian relationships", async () => {
  for (const role of ["founder", "admin", "data_reviewer", "contractor"] as const) {
    const service = new GuardianRelationshipService(repositoryStub([]));
    await assert.rejects(
      service.searchGuardians({ actor: actor(role), studentId: STUDENT_ID, query: "gu" }),
      (error: unknown) => error instanceof GuardianRelationshipError &&
        error.code === "GUARDIAN_RELATIONSHIP_FORBIDDEN",
    );
  }
});

test("relationship vocabulary and search length fail closed", async () => {
  const service = new GuardianRelationshipService(repositoryStub([]));
  await assert.rejects(
    service.attachGuardian({
      actor: actor("advisor"),
      command: {
        studentId: STUDENT_ID,
        guardianId: GUARDIAN_ID,
        relationshipType: "parent" as "father",
        isLegalGuardian: true,
        isEmergencyContact: false,
        isBillingContact: false,
        notificationConsent: false,
        requestId: "crm02.invalid",
        idempotencyKey: "crm02-invalid-1",
      },
    }),
    (error: unknown) => error instanceof GuardianRelationshipError &&
      error.code === "GUARDIAN_RELATIONSHIP_INVALID",
  );
  await assert.rejects(
    service.searchGuardians({ actor: actor("advisor"), studentId: STUDENT_ID, query: "x" }),
    (error: unknown) => error instanceof GuardianRelationshipError &&
      error.code === "GUARDIAN_RELATIONSHIP_INVALID",
  );
});

test("students.read continues to allow Founder, Admin and Advisor current relationship reads", async () => {
  for (const role of ["founder", "admin", "advisor"] as const) {
    const view = await new GuardianRelationshipService(repositoryStub([])).listCurrent(
      actor(role),
      STUDENT_ID,
    );
    assert.equal(view.student.id, STUDENT_ID);
  }
});

function actor(role: IdentitySessionActor["role"]): IdentitySessionActor {
  return {
    userId: ACTOR_ID,
    organizationId: ORGANIZATION_ID,
    role,
    sessionId: "33333333-3333-4333-8333-333333333333",
    capturedSessionVersion: 1,
    reauthenticatedAtMs: null,
  };
}

function repositoryStub(
  calls: Array<{ name: string; input: Record<string, unknown> }>,
): GuardianRelationshipRepository {
  const relationship = Object.freeze({
    relationshipId: IDS[0]!,
    studentId: STUDENT_ID,
    guardianId: GUARDIAN_ID,
    relationshipType: "father" as const,
    isLegalGuardian: true,
    isPrimaryContact: false,
    isEmergencyContact: false,
    isBillingContact: false,
    notificationConsent: false,
    startsAt: "2025-08-04T00:00:00.000Z",
    recordVersion: 1,
  });
  return {
    async listCurrent() {
      return {
        student: { id: STUDENT_ID, displayName: "Synthetic Student" },
        relationships: [{
          relationship,
          guardian: { id: GUARDIAN_ID, displayName: "Synthetic Guardian", emailHint: null, phoneHint: null },
        }],
      };
    },
    async searchGuardians() {
      return [{ id: GUARDIAN_ID, displayName: "Synthetic Guardian", emailHint: null, phoneHint: null }];
    },
    async createRelationship(input) {
      calls.push({ name: "attach", input: input as unknown as Record<string, unknown> });
      return relationship;
    },
    async handoffPrimaryContact(input) {
      calls.push({ name: "handoff", input: input as unknown as Record<string, unknown> });
      return {
        relationship: { ...relationship, relationshipId: input.relationshipId, isPrimaryContact: true, recordVersion: 2 },
        closedRelationshipIds: {
          previousPrimary: "80000000-0000-4000-8000-000000000001",
          successorSecondary: "80000000-0000-4000-8000-000000000002",
        },
      };
    },
  };
}
