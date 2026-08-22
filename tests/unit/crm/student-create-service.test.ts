import assert from "node:assert/strict";
import test from "node:test";

import type { IdentitySessionActor } from "../../../modules/identity/public.ts";
import {
  StudentCreateError,
  StudentCreateRepositoryError,
  StudentCreateService,
  isStudentCreateError,
  type StudentCreateCommand,
  type StudentCreateRepository,
} from "../../../modules/crm/application/student-create-service.ts";

const IDS = Object.freeze({
  organization: "61000000-0000-4000-8000-000000000001",
  actor: "61000000-0000-4000-8000-000000000002",
  session: "61000000-0000-4000-8000-000000000003",
  student: "61000000-0000-4000-8000-000000000004",
  guardian: "61000000-0000-4000-8000-000000000005",
  relationship: "61000000-0000-4000-8000-000000000006",
  audit: "61000000-0000-4000-8000-000000000007",
  outbox: "61000000-0000-4000-8000-000000000008",
});

test("Founder and Advisor create a normalized aggregate with redacted effects", async () => {
  for (const role of ["founder", "advisor"] as const) {
    let observed: Parameters<StudentCreateRepository["createStudent"]>[0] | undefined;
    const service = serviceWith(async (input) => {
      observed = input;
      return created(input);
    });
    const result = await service.create({ actor: actor(role), command: command() });

    assert.equal(result.student.displayName, "Synthetic Student");
    assert.equal(observed?.student.contactEmail, "student@example.invalid");
    assert.equal(observed?.primaryGuardian.email, "guardian@example.invalid");
    assert.equal(observed?.primaryGuardian.phone, null);
    assert.match(observed?.requestHash ?? "", /^[a-f0-9]{64}$/);
    assert.deepEqual(observed?.effects.audit.metadata, {
      effect_type: "crm.student_created",
      record_version: 1,
      status: "active",
    });
    assert.deepEqual(observed?.effects.outbox.payload, {
      aggregate_id: IDS.student,
      effect_type: "crm.student_created",
      record_version: 1,
      request_id: "crm-create-request-1",
      status: "active",
    });
    const serializedEffects = JSON.stringify(observed?.effects);
    for (const privateValue of [
      "Synthetic Student",
      "Synthetic Guardian",
      "student@example.invalid",
      "guardian@example.invalid",
    ]) assert.equal(serializedEffects.includes(privateValue), false);
  }
});

test("Admin and other roles are denied before repository access", async () => {
  for (const role of ["admin", "data_reviewer", "contractor"] as const) {
    let called = false;
    const service = serviceWith(async (input) => {
      called = true;
      return created(input);
    });
    await assert.rejects(
      service.create({ actor: actor(role), command: command() }),
      hasCode("STUDENT_CREATE_FORBIDDEN"),
    );
    assert.equal(called, false);
  }
});

test("stable error guard recognizes a StudentCreateError from another module instance", () => {
  const crossModuleError = new Error("redacted");
  crossModuleError.name = "StudentCreateError";
  Object.defineProperty(crossModuleError, "code", {
    value: "STUDENT_CREATE_FORBIDDEN",
    enumerable: true,
  });

  assert.equal(isStudentCreateError(crossModuleError), true);
  assert.equal(isStudentCreateError(crossModuleError, "STUDENT_CREATE_FORBIDDEN"), true);
  assert.equal(isStudentCreateError(crossModuleError, "STUDENT_CREATE_INVALID"), false);
  assert.equal(isStudentCreateError(Object.freeze({
    name: "StudentCreateError",
    code: "STUDENT_CREATE_FORBIDDEN",
  })), false);
  const unknownCode = new Error("redacted");
  unknownCode.name = "StudentCreateError";
  Object.defineProperty(unknownCode, "code", { value: "UNKNOWN" });
  assert.equal(isStudentCreateError(unknownCode), false);
});

test("validation freezes relationship vocabulary, contact requirement, dates and idempotency", async () => {
  const invalidCommands: StudentCreateCommand[] = [
    { ...command(), primaryGuardian: { ...command().primaryGuardian, relationshipType: "parent" as "father" } },
    { ...command(), primaryGuardian: { ...command().primaryGuardian, email: null, phone: null } },
    { ...command(), student: { ...command().student, dateOfBirth: "2026-02-31" } },
    { ...command(), idempotencyKey: "not allowed whitespace" },
  ];
  for (const invalid of invalidCommands) {
    await assert.rejects(
      serviceWith(async (input) => created(input)).create({ actor: actor("advisor"), command: invalid }),
      hasCode("STUDENT_CREATE_INVALID"),
    );
  }
});

test("repository conflicts and unavailability retain stable service errors", async () => {
  for (const code of [
    "STUDENT_CREATE_IDEMPOTENCY_CONFLICT",
    "STUDENT_CREATE_IDEMPOTENCY_IN_PROGRESS",
    "STUDENT_CREATE_UNAVAILABLE",
  ] as const) {
    const service = serviceWith(async () => { throw new StudentCreateRepositoryError(code); });
    await assert.rejects(
      service.create({ actor: actor("founder"), command: command() }),
      hasCode(code),
    );
  }
});

function serviceWith(
  createStudent: StudentCreateRepository["createStudent"],
): StudentCreateService {
  const ids = [IDS.student, IDS.guardian, IDS.relationship, IDS.audit, IDS.outbox];
  return new StudentCreateService(
    { createStudent },
    () => ids.shift()!,
    () => Date.parse("2026-08-22T08:00:00.000Z"),
  );
}

function command(): StudentCreateCommand {
  return {
    student: {
      displayName: " Synthetic Student ",
      dateOfBirth: "2013-06-18",
      contactEmail: " Student@Example.Invalid ",
      contactPhone: null,
    },
    primaryGuardian: {
      displayName: " Synthetic Guardian ",
      email: " Guardian@Example.Invalid ",
      phone: " ",
      relationshipType: "father",
      isLegalGuardian: true,
    },
    requestId: "crm-create-request-1",
    idempotencyKey: "crm-create-attempt-1",
  };
}

function actor(role: IdentitySessionActor["role"]): IdentitySessionActor {
  return {
    userId: IDS.actor,
    organizationId: IDS.organization,
    role,
    sessionId: IDS.session,
    capturedSessionVersion: 1,
    reauthenticatedAtMs: null,
  };
}

function created(input: Parameters<StudentCreateRepository["createStudent"]>[0]) {
  return {
    student: { id: input.studentId, displayName: input.student.displayName },
    primaryGuardian: { id: input.guardianId, displayName: input.primaryGuardian.displayName },
    relationship: {
      id: input.relationshipId,
      relationshipType: input.primaryGuardian.relationshipType,
    },
  } as const;
}

function hasCode(code: StudentCreateError["code"]) {
  return (error: unknown) => error instanceof StudentCreateError && error.code === code;
}
