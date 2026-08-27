import assert from "node:assert/strict";
import test from "node:test";

import {
  GuardianRelationshipError,
  GuardianRelationshipService,
  type GuardianRelationshipRepository,
} from "../../modules/crm/application/guardian-relationship-service.ts";
import { workspaceCapabilitiesForRole, type OrganizationRole, type Release1OrganizationRole, type RequestAccessActor } from "../../modules/access/public.ts";

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

test("Guardian management fixes attach primary=false and handoff reason server-side", async () => {
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
      relationshipDescription: null,
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

test("Admin, Data Reviewer and Contractor cannot manage Guardian relationships", async () => {
  await new GuardianRelationshipService(repositoryStub([])).searchGuardians({ actor: actor("founder"), studentId: STUDENT_ID, query: "gu" });
  for (const role of ["admin", "data_reviewer", "contractor"] as const) {
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
        relationshipType: "other_guardian" as "father",
        relationshipDescription: null,
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

test("students.read allows Founder and Advisor current relationship reads", async () => {
  for (const role of ["founder", "advisor"] as const) {
    const view = await new GuardianRelationshipService(repositoryStub([])).listCurrent(
      actor(role),
      STUDENT_ID,
    );
    assert.equal(view.student.id, STUDENT_ID);
  }
  await assert.rejects(new GuardianRelationshipService(repositoryStub([])).listCurrent(actor("admin"), STUDENT_ID));
});

test("history reads current and ended relationships with access boundaries", async () => {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  const repository = repositoryStub(calls);
  for (const role of ["founder", "advisor"] as const) assert.equal((await new GuardianRelationshipService(repository).listHistory(actor(role), STUDENT_ID)).relationships.length, 2);
  for (const role of ["admin", "contractor"] as const) await assert.rejects(new GuardianRelationshipService(repository).listHistory(actor(role), STUDENT_ID));
  await assert.rejects(new GuardianRelationshipService({ ...repository, async listHistory() { return null; } }).listHistory(actor("advisor"), STUDENT_ID));
  await assert.rejects(new GuardianRelationshipService(repository).listHistory(actor("advisor"), "bad"));
});

test("current reads preserve repository visibility and fail closed when the Student is not readable", async () => {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  const repository = repositoryStub(calls);
  const service = new GuardianRelationshipService(repository);
  const view = await service.listCurrent(actor("advisor"), STUDENT_ID);
  assert.equal(view.relationships[0]?.guardian.emailHint, null);

  await assert.rejects(
    new GuardianRelationshipService({ ...repository, async listCurrent() { return null; } })
      .listCurrent(actor("advisor"), STUDENT_ID),
    (error: unknown) => error instanceof GuardianRelationshipError &&
      error.code === "GUARDIAN_RELATIONSHIP_STUDENT_NOT_FOUND",
  );
  await assert.rejects(
    service.listCurrent(actor("contractor"), STUDENT_ID),
    (error: unknown) => error instanceof GuardianRelationshipError &&
      error.code === "GUARDIAN_RELATIONSHIP_FORBIDDEN",
  );
});

function actor(role: OrganizationRole): RequestAccessActor {
  const roles: readonly Release1OrganizationRole[] = role === "data_reviewer" ? [] : [role];
  return {
    userId: ACTOR_ID,
    organizationId: ORGANIZATION_ID,
    roles, workspaceCapabilities: workspaceCapabilitiesForRole(role),
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
    async listHistory() {
      return { student: { id: STUDENT_ID, displayName: "Synthetic Student" }, relationships: [{ relationship, guardian: { id: GUARDIAN_ID, displayName: "Synthetic Guardian", emailHint: null, phoneHint: null } }, { relationship: { ...relationship, relationshipId: IDS[1]!, endsAt: "2026-01-01T00:00:00.000Z" }, guardian: { id: GUARDIAN_ID, displayName: "Deleted guardian", emailHint: null, phoneHint: null } }] };
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
    async endRelationship() {
      throw new Error("end relationship repository is outside this workflow fixture");
    },
  };
}
