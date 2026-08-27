import assert from "node:assert/strict";
import test from "node:test";

import {
  mergeWorkspaceCapabilities,
  type RequestAccessActor,
} from "../../../modules/access/public.ts";
import {
  CaseIntakeError,
  CaseIntakeOptionsCoordinator,
  CaseIntakeService,
  type CaseIntakeRepository,
} from "../../../modules/cases/application/intake-service.ts";
import type {
  AccessCaseIntakeOwnerPort,
  CrmCaseIntakeOwnerPort,
} from "../../../modules/shared/public.ts";

const IDS = Object.freeze({
  organization: "81000000-0000-4000-8000-000000000001",
  actor: "81000000-0000-4000-8000-000000000002",
  binding: "81000000-0000-4000-8000-000000000003",
  student: "81000000-0000-4000-8000-000000000004",
  source: "81000000-0000-4000-8000-000000000005",
  case: "81000000-0000-4000-8000-000000000006",
  assessment: "81000000-0000-4000-8000-000000000007",
  transition: "81000000-0000-4000-8000-000000000008",
  assignment: "81000000-0000-4000-8000-000000000009",
  idem: "81000000-0000-4000-8000-000000000010",
  audit: "81000000-0000-4000-8000-000000000011",
  outbox: "81000000-0000-4000-8000-000000000012",
});
const NOW = Date.parse("2026-08-26T02:30:00.000Z");

test("Advisor capability union creates exact D5 receipt and canonicalizes signed_at before hash", async () => {
  let observed: Parameters<CaseIntakeRepository["createCase"]>[0] | undefined;
  const service = createService({
    async createCase(input) {
      observed = input;
      return receipt();
    },
  });
  const result = await service.createCase({
    actor: actor(["founder", "advisor"]),
    command: command({ signedAt: "2026-08-26T10:30:00+08:00" }),
  });

  assert.deepEqual(result, receipt());
  assert.equal(observed?.signedAt, "2026-08-26T02:30:00.000Z");
  assert.match(observed?.requestHash ?? "", /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(observed?.effects).includes("Synthetic"), false);
});

test("Founder alone, Founder+Admin, Admin and Contractor cannot create Case intake", async () => {
  for (const roles of [["founder"], ["founder", "admin"], ["admin"], ["contractor"]] as const) {
    let called = false;
    const service = createService({
      async createCase() {
        called = true;
        return receipt();
      },
    });
    await assert.rejects(
      service.createCase({ actor: actor(roles), command: command() }),
      (error: unknown) => error instanceof CaseIntakeError && error.code === "CASE_INTAKE_FORBIDDEN",
    );
    assert.equal(called, false);
  }
});

test("options coordinator combines owner ports and caps each active option list at twenty", async () => {
  const crm: CrmCaseIntakeOwnerPort = {
    async listStudents() { return Array.from({ length: 25 }, (_, i) => ({ id: `${IDS.student}-${i}`, displayName: `Student ${i}` })); },
    async listReferralSources() { return Array.from({ length: 25 }, (_, i) => ({ id: `${IDS.source}-${i}`, displayName: `Source ${i}` })); },
    async lockStudent() { return true; },
    async lockReferralSource() { return null; },
  };
  const access: AccessCaseIntakeOwnerPort = {
    async listAdvisors() { return Array.from({ length: 25 }, (_, i) => ({ id: `${IDS.binding}-${i}`, role: "advisor" as const, displayName: `Advisor ${i}` })); },
    async lockAdvisor() { return null; },
    async assertCurrentAdvisor() { return true; },
  };
  const coordinator = new CaseIntakeOptionsCoordinator(crm, access);
  const options = await coordinator.list({
    organizationId: IDS.organization,
    actorUserId: IDS.actor,
    studentQuery: "  stu ",
    advisorQuery: null,
    referralSourceQuery: null,
  });
  assert.equal(options.students.length, 20);
  assert.equal(options.advisors.length, 20);
  assert.equal(options.referralSources.length, 20);
  assert.equal(Object.prototype.hasOwnProperty.call(options, "total"), false);
});

test("inactive ReferralSource is a stable not-found result from the owner repository boundary", async () => {
  const service = createService({
    async createCase() {
      throw new CaseIntakeError("CASE_INTAKE_REFERRAL_SOURCE_NOT_FOUND");
    },
  });
  await assert.rejects(
    service.createCase({ actor: actor(["advisor"]), command: command({ referralSourceId: IDS.source }) }),
    (error: unknown) => error instanceof CaseIntakeError && error.code === "CASE_INTAKE_REFERRAL_SOURCE_NOT_FOUND",
  );
});

test("same idempotency payload replays and a changed payload conflicts", async () => {
  let firstRequestHash: string | undefined;
  const service = createService({
    async createCase(input) {
      if (firstRequestHash === undefined) {
        firstRequestHash = input.requestHash;
        return receipt();
      }
      if (input.requestHash === firstRequestHash) return receipt();
      throw new CaseIntakeError("CASE_INTAKE_IDEMPOTENCY_CONFLICT");
    },
  });
  const first = await service.createCase({
    actor: actor(["advisor"]),
    command: command(),
  });
  const replay = await service.createCase({
    actor: actor(["advisor"]),
    command: command(),
  });
  assert.deepEqual(replay, first);
  await assert.rejects(
    service.createCase({
      actor: actor(["advisor"]),
      command: command({ signedAt: "2026-08-26T03:30:00.000Z" }),
    }),
    (error: unknown) => error instanceof CaseIntakeError &&
      error.code === "CASE_INTAKE_IDEMPOTENCY_CONFLICT",
  );
});

function createService(overrides: Partial<CaseIntakeRepository>): CaseIntakeService {
  const repository: CaseIntakeRepository = {
    async createCase() { return receipt(); },
    ...overrides,
  };
  const crm: CrmCaseIntakeOwnerPort = {
    async listStudents() { return []; },
    async listReferralSources() { return []; },
    async lockStudent() { return true; },
    async lockReferralSource() { return null; },
  };
  const access: AccessCaseIntakeOwnerPort = {
    async listAdvisors() { return []; },
    async lockAdvisor() { return null; },
    async assertCurrentAdvisor() { return true; },
  };
  return new CaseIntakeService(repository, new CaseIntakeOptionsCoordinator(crm, access), () => IDS.case, () => NOW);
}

function actor(roles: readonly ("founder" | "admin" | "advisor" | "contractor")[]): RequestAccessActor {
  return Object.freeze({
    userId: IDS.actor,
    organizationId: IDS.organization,
    roles,
    workspaceCapabilities: mergeWorkspaceCapabilities(roles),
  });
}

function command(overrides: Partial<{
  readonly signedAt: string;
  readonly referralSourceId: string | null;
}> = {}) {
  return {
    studentId: IDS.student,
    primaryAdvisorRoleBindingId: IDS.binding,
    referralSourceId: null,
    intakeYear: 2027,
    admissionType: "entry" as const,
    signedAt: "2026-08-26T02:30:00.000Z",
    requestId: "d5-case-request",
    idempotencyKey: "d5-case-idempotency",
    ...overrides,
  };
}

function receipt() {
  return {
    caseId: IDS.case,
    stage: "background_collection" as const,
    workflowStatus: "active" as const,
    recordVersion: 2,
    assessmentManifest: { id: "82000000-0000-4000-8000-000000000001", version: "k12-catalogue-v1" },
    assessmentUrl: `/cases/${IDS.case}/assessment`,
  };
}
