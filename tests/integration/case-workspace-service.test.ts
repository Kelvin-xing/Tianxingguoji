import assert from "node:assert/strict";
import test from "node:test";

import {
  CaseWorkspaceError,
  CaseWorkspaceService,
  isCaseWorkspaceError,
  type CaseWorkspaceRepository,
} from "../../modules/cases/application/workspace-service.ts";
import type { IdentitySessionActor } from "../../modules/identity/public.ts";

const ids = Object.freeze({
  organization: "41000000-0000-4000-8000-000000000001",
  actor: "41000000-0000-4000-8000-000000000002",
  session: "41000000-0000-4000-8000-000000000003",
  student: "41000000-0000-4000-8000-000000000004",
  binding: "41000000-0000-4000-8000-000000000005",
  manifest: "41000000-0000-4000-8000-000000000006",
  case: "41000000-0000-4000-8000-000000000007",
  assessment: "41000000-0000-4000-8000-000000000008",
  audit: "41000000-0000-4000-8000-000000000009",
  outbox: "41000000-0000-4000-8000-00000000000a",
});

test("creates an existing-student case with audit and idempotency context", async () => {
  let observed: Parameters<CaseWorkspaceRepository["createCase"]>[0] | undefined;
  const repository = fakeRepository({
    async createCase(input) {
      observed = input;
      return {
        id: input.serviceCaseId,
        caseNumber: input.caseNumber,
        studentId: input.studentId,
        assessmentId: input.assessmentId,
        intakeYear: input.intakeYear,
        admissionType: input.admissionType,
        stage: "signed",
        manifestId: input.manifestId,
        recordVersion: 1,
      };
    },
  });
  const createdIds = [ids.case, ids.assessment, ids.audit, ids.outbox];
  const service = new CaseWorkspaceService(
    repository,
    () => createdIds.shift()!,
    () => Date.parse("2026-08-18T10:00:00.000Z"),
  );

  const result = await service.createCase({ actor: actor("advisor"), command: command() });

  assert.equal(result.id, ids.case);
  assert.equal(result.studentId, ids.student);
  assert.match(result.caseNumber, /^TX-2027-/);
  assert.equal(observed?.actorRole, "advisor");
  assert.equal(observed?.idempotencyKey, "case-workspace-test-1");
  assert.match(observed?.requestHash ?? "", /^[a-f0-9]{64}$/);
  assert.equal(observed?.effects.audit.id, ids.audit);
  assert.equal(observed?.effects.outbox.auditEventId, ids.audit);
  assert.equal(observed?.effects.audit.resourceId, ids.case);
});

test("rejects non-workspace roles before repository access", async () => {
  let called = false;
  const service = new CaseWorkspaceService(fakeRepository({
    async createCase() {
      called = true;
      throw new Error("unexpected");
    },
  }));

  await assert.rejects(
    service.createCase({ actor: actor("contractor"), command: command() }),
    (error: unknown) => error instanceof CaseWorkspaceError &&
      error.code === "CASE_WORKSPACE_FORBIDDEN",
  );
  assert.equal(called, false);
});

test("maps repository conflicts to the application error contract", async () => {
  const createdIds = [ids.case, ids.assessment, ids.audit, ids.outbox];
  const service = new CaseWorkspaceService(fakeRepository({
    async createCase() {
      throw Object.assign(new Error("duplicated module instance"), {
        name: "CaseWorkspaceRepositoryError",
        code: "CASE_WORKSPACE_DUPLICATE",
      });
    },
  }), () => createdIds.shift()!, () => Date.parse("2026-08-18T10:00:00.000Z"));

  await assert.rejects(
    service.createCase({ actor: actor("founder"), command: command() }),
    (error: unknown) => isCaseWorkspaceError(error, "CASE_WORKSPACE_DUPLICATE"),
  );
});

function fakeRepository(
  override: Pick<CaseWorkspaceRepository, "createCase">,
): CaseWorkspaceRepository {
  return {
    listCases: async () => [],
    findCase: async () => null,
    listOptions: async () => ({ students: [], primaryBindings: [], manifests: [] }),
    ...override,
  };
}

function actor(role: IdentitySessionActor["role"]): IdentitySessionActor {
  return {
    userId: ids.actor,
    organizationId: ids.organization,
    role,
    sessionId: ids.session,
    capturedSessionVersion: 1,
    reauthenticatedAtMs: null,
  };
}

function command() {
  return {
    studentId: ids.student,
    intakeYear: 2027,
    admissionType: "transfer",
    primaryRoleBindingId: ids.binding,
    manifestId: ids.manifest,
    requestId: "7case-workspace-request",
    idempotencyKey: "case-workspace-test-1",
  };
}
