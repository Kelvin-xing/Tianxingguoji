import assert from "node:assert/strict";
import test from "node:test";

import {
  ProfileMaintenanceError,
  ProfileMaintenanceService,
  type ProfileMaintenanceRepository,
} from "../../../modules/crm/application/profile-maintenance-service.ts";
import type { IdentitySessionActor } from "../../../modules/identity/public.ts";

const IDS = Object.freeze({
  organization: "51000000-0000-4000-8000-000000000001",
  founder: "51000000-0000-4000-8000-000000000101",
  student: "51000000-0000-4000-8000-000000000601",
  guardian: "51000000-0000-4000-8000-000000000701",
  audit: "51000000-0000-4000-8000-000000000801",
  outbox: "51000000-0000-4000-8000-000000000802",
});

function actor(role: IdentitySessionActor["role"]): IdentitySessionActor {
  return Object.freeze({ userId: IDS.founder, organizationId: IDS.organization, role,
    sessionId: "51000000-0000-4000-8000-000000000901", capturedSessionVersion: 1,
    reauthenticatedAtMs: null });
}

test("normalizes Student profile values and creates only PII-free effects", async () => {
  let captured: Parameters<ProfileMaintenanceRepository["updateStudent"]>[0] | undefined;
  const repository: ProfileMaintenanceRepository = {
    async updateStudent(input) {
      captured = input;
      return { id: input.studentId, recordVersion: 2, updatedAt: "2026-08-23T00:00:00.000Z" };
    },
    async updateGuardian() { throw new Error("unexpected"); },
  };
  const ids = [IDS.audit, IDS.outbox];
  const service = new ProfileMaintenanceService(repository, () => ids.shift()!, () => 1_777_075_200_000);
  const result = await service.updateStudent({ actor: actor("founder"), command: {
    studentId: IDS.student, displayName: "  Synthetic Student  ", dateOfBirth: "2012-06-01",
    contactEmail: " STUDENT@EXAMPLE.INVALID ", contactPhone: "  +852 2000 0000  ",
    expectedRecordVersion: 1, requestId: "request-1", idempotencyKey: "student-profile:1",
  } });
  assert.deepEqual(result, { id: IDS.student, recordVersion: 2, updatedAt: "2026-08-23T00:00:00.000Z" });
  assert.equal(captured?.displayName, "Synthetic Student");
  assert.equal(captured?.contactEmail, "student@example.invalid");
  assert.equal(captured?.contactPhone, "+852 2000 0000");
  const serializedEffects = JSON.stringify(captured?.effects);
  for (const pii of ["Synthetic Student", "student@example.invalid", "+852 2000 0000", "2012-06-01"]) {
    assert.equal(serializedEffects.includes(pii), false);
  }
  assert.match(captured?.requestHash ?? "", /^[0-9a-f]{64}$/);
});

test("allows only Founder and Advisor and rejects all other roles before repository access", async () => {
  let calls = 0;
  const repository: ProfileMaintenanceRepository = {
    async updateStudent(input) { calls += 1; return { id: input.studentId, recordVersion: 2,
      updatedAt: "2026-08-23T00:00:00.000Z" }; },
    async updateGuardian(input) { calls += 1; return { id: input.guardianId, recordVersion: 2,
      updatedAt: "2026-08-23T00:00:00.000Z" }; },
  };
  for (const role of ["founder", "advisor"] as const) {
    const ids = [IDS.audit, IDS.outbox];
    await new ProfileMaintenanceService(repository, () => ids.shift()!, () => Date.now())
      .updateGuardian({ actor: actor(role), command: { guardianId: IDS.guardian,
        displayName: "Guardian", email: "guardian@example.invalid", phone: null,
        expectedRecordVersion: 1, requestId: `request-${role}`,
        idempotencyKey: `guardian-profile:${role}` } });
  }
  assert.equal(calls, 2);
  for (const role of ["admin", "data_reviewer", "contractor"] as const) {
    await assert.rejects(
      new ProfileMaintenanceService(repository).updateGuardian({ actor: actor(role), command: {
        guardianId: IDS.guardian, displayName: "Guardian", email: "guardian@example.invalid",
        phone: null, expectedRecordVersion: 1, requestId: "request-denied",
        idempotencyKey: `guardian-profile:${role}` } }),
      (error: unknown) => error instanceof ProfileMaintenanceError &&
        error.code === "PROFILE_MAINTENANCE_FORBIDDEN",
    );
  }
  assert.equal(calls, 2);
});

test("rejects invalid normalized fields without calling the repository", async () => {
  const repository: ProfileMaintenanceRepository = {
    async updateStudent() { throw new Error("unexpected"); },
    async updateGuardian() { throw new Error("unexpected"); },
  };
  const service = new ProfileMaintenanceService(repository);
  await assert.rejects(service.updateStudent({ actor: actor("founder"), command: {
    studentId: IDS.student, displayName: "Student", dateOfBirth: "2026-02-30",
    contactEmail: null, contactPhone: null, expectedRecordVersion: 1,
    requestId: "request-invalid", idempotencyKey: "student-profile:invalid",
  } }), (error: unknown) => error instanceof ProfileMaintenanceError &&
    error.code === "PROFILE_MAINTENANCE_INVALID");
  await assert.rejects(service.updateGuardian({ actor: actor("founder"), command: {
    guardianId: IDS.guardian, displayName: "Guardian", email: null, phone: null,
    expectedRecordVersion: 1, requestId: "request-invalid",
    idempotencyKey: "guardian-profile:invalid",
  } }), (error: unknown) => error instanceof ProfileMaintenanceError &&
    error.code === "PROFILE_MAINTENANCE_INVALID");
});
