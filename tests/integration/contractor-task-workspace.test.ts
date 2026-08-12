import assert from "node:assert/strict";
import test from "node:test";

import type { IdentitySessionActor } from "../../modules/identity/session-repository.ts";
import {
  evaluateContractorTaskAccess,
  type ContractorTaskAssignmentContext,
} from "../../modules/access/policy.ts";
import {
  ContractorTaskWorkspaceError,
  ContractorTaskWorkspaceService,
  type ContractorTaskWorkspaceRepository,
  type ContractorTaskWorkspaceRepositoryInput,
  type ContractorTaskWorkspaceResult,
} from "../../modules/tasks/contractor-workspace.ts";
import { getContractorTaskWorkspaceRuntime } from "../../modules/tasks/contractor-workspace-runtime.ts";
import { createContractorTaskGetHandler } from "../../modules/tasks/contractor-route.ts";

const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000401";
const CONTRACTOR_ID = "00000000-0000-4000-8000-000000000402";
const OTHER_CONTRACTOR_ID = "00000000-0000-4000-8000-000000000403";
const TASK_ID = "00000000-0000-4000-8000-000000000404";

function actor(overrides: Partial<IdentitySessionActor> = {}): IdentitySessionActor {
  return {
    userId: CONTRACTOR_ID,
    organizationId: ORGANIZATION_ID,
    role: "contractor",
    sessionId: "00000000-0000-4000-8000-000000000405",
    capturedSessionVersion: 1,
    reauthenticatedAtMs: null,
    ...overrides,
  };
}

function assignment(
  overrides: Partial<ContractorTaskAssignmentContext> = {},
): ContractorTaskAssignmentContext {
  return {
    requestOrganizationId: ORGANIZATION_ID,
    actorOrganizationId: ORGANIZATION_ID,
    actorUserId: CONTRACTOR_ID,
    actorRole: "contractor",
    actorIsActive: true,
    taskOrganizationId: ORGANIZATION_ID,
    currentAssigneeUserId: CONTRACTOR_ID,
    currentAssigneeRole: "contractor",
    assignmentStatus: "active",
    redactionLevel: "task_only",
    ...overrides,
  };
}

class TransactionalWorkspaceFake implements ContractorTaskWorkspaceRepository {
  context = assignment();
  projection: ContractorTaskWorkspaceResult = Object.freeze({
    task_id: TASK_ID,
    title: "Prepare the school submission checklist",
    task_brief: "Confirm the listed deliverables and record completion.",
    due_at: "2026-08-14T09:00:00.000Z",
    state: "accepted",
    record_version: 3,
  });
  transactionCount = 0;

  async getAssignedTaskWorkspace(
    input: ContractorTaskWorkspaceRepositoryInput,
  ): Promise<ContractorTaskWorkspaceResult> {
    this.transactionCount += 1;
    const decision = evaluateContractorTaskAccess({
      ...this.context,
      requestOrganizationId: input.organizationId,
      actorOrganizationId: input.actor.organizationId,
      actorUserId: input.actor.userId,
      actorRole: input.actor.role,
    });
    if (!decision.allowed || input.taskId !== TASK_ID) {
      throw new ContractorTaskWorkspaceError("CONTRACTOR_TASK_NOT_FOUND");
    }
    return this.projection;
  }
}

test("assigned contractor receives only the exact task-only DTO allowlist", async () => {
  const repository = new TransactionalWorkspaceFake();
  repository.projection = Object.freeze({
    ...repository.projection,
    internal_notes: "adapter field that must never cross the service boundary",
  }) as ContractorTaskWorkspaceResult;
  const service = new ContractorTaskWorkspaceService({ repository });

  const result = await service.getAssignedTask({ actor: actor(), taskId: TASK_ID });

  assert.equal(repository.transactionCount, 1);
  assert.deepEqual(Object.keys(result).sort(), [
    "due_at",
    "record_version",
    "state",
    "task_brief",
    "task_id",
    "title",
  ]);
  const serialized = JSON.stringify(result);
  for (const forbidden of [
    "case_id",
    "case_number",
    "student",
    "guardian",
    "family",
    "email",
    "phone",
    "identity_contact",
    "internal_notes",
    "case_summary",
    "export",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("direct service access denies every actor except the current active task-only contractor", async () => {
  const denied: readonly Partial<ContractorTaskAssignmentContext>[] = [
    { actorRole: "advisor" },
    { actorIsActive: false },
    { currentAssigneeUserId: OTHER_CONTRACTOR_ID },
    { currentAssigneeRole: "advisor" },
    { assignmentStatus: "revoked" },
    { redactionLevel: "full" },
    { taskOrganizationId: "00000000-0000-4000-8000-000000000499" },
  ];

  for (const override of denied) {
    assert.equal(evaluateContractorTaskAccess(assignment(override)).allowed, false);
  }
});

test("revoked or reassigned assignment denies at request time without a residual projection", async () => {
  const repository = new TransactionalWorkspaceFake();
  const service = new ContractorTaskWorkspaceService({ repository });

  repository.context = assignment({ assignmentStatus: "revoked" });
  await assert.rejects(
    service.getAssignedTask({ actor: actor(), taskId: TASK_ID }),
    (error: unknown) =>
      error instanceof ContractorTaskWorkspaceError && error.code === "CONTRACTOR_TASK_NOT_FOUND",
  );

  repository.context = assignment({ currentAssigneeUserId: OTHER_CONTRACTOR_ID });
  await assert.rejects(
    service.getAssignedTask({ actor: actor(), taskId: TASK_ID }),
    (error: unknown) =>
      error instanceof ContractorTaskWorkspaceError && error.code === "CONTRACTOR_TASK_NOT_FOUND",
  );
});

test("service rejects non-contractor direct calls before repository access", async () => {
  const repository = new TransactionalWorkspaceFake();
  const service = new ContractorTaskWorkspaceService({ repository });

  await assert.rejects(
    service.getAssignedTask({ actor: actor({ role: "advisor" }), taskId: TASK_ID }),
    (error: unknown) =>
      error instanceof ContractorTaskWorkspaceError && error.code === "CONTRACTOR_TASK_FORBIDDEN",
  );
  assert.equal(repository.transactionCount, 0);
});

test("direct API access without an opaque session returns the versioned 401 envelope", async () => {
  const handler = createContractorTaskGetHandler({
    getSessionSecret: async () => null,
    requireSession: async () => actor(),
    getWorkspaceService: () => new ContractorTaskWorkspaceService({
      repository: new TransactionalWorkspaceFake(),
    }),
  });

  const response = await handler(
    new Request(`https://erp.example.test/api/v1/contractor/tasks/${TASK_ID}`),
    { params: Promise.resolve({ taskId: TASK_ID }) },
  );
  const body = await response.json();

  assert.equal(response.status, 401);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(body.error.code, "UNAUTHENTICATED");
  assert.equal(JSON.stringify(body).includes(TASK_ID), false);
});

test("direct API access by a non-contractor is denied without repository access", async () => {
  const repository = new TransactionalWorkspaceFake();
  const handler = createContractorTaskGetHandler({
    getSessionSecret: async () => "opaque-session-secret",
    requireSession: async () => actor({ role: "advisor" }),
    getWorkspaceService: () => new ContractorTaskWorkspaceService({ repository }),
  });

  const response = await handler(
    new Request(`https://erp.example.test/api/v1/contractor/tasks/${TASK_ID}`),
    { params: Promise.resolve({ taskId: TASK_ID }) },
  );
  const body = await response.json();

  assert.equal(response.status, 403);
  assert.equal(body.error.code, "FORBIDDEN");
  assert.equal(repository.transactionCount, 0);
});

test("direct API access after assignment revoke returns opaque not found", async () => {
  const repository = new TransactionalWorkspaceFake();
  repository.context = assignment({ assignmentStatus: "revoked" });
  const handler = createContractorTaskGetHandler({
    getSessionSecret: async () => "opaque-session-secret",
    requireSession: async () => actor(),
    getWorkspaceService: () => new ContractorTaskWorkspaceService({ repository }),
  });

  const response = await handler(
    new Request(`https://erp.example.test/api/v1/contractor/tasks/${TASK_ID}`),
    { params: Promise.resolve({ taskId: TASK_ID }) },
  );
  const body = await response.json();

  assert.equal(response.status, 404);
  assert.equal(body.error.code, "NOT_FOUND");
  assert.equal(JSON.stringify(body).includes(TASK_ID), false);
});

test("production contractor workspace runtime fails closed without the HK RDS adapter", () => {
  assert.throws(getContractorTaskWorkspaceRuntime, {
    name: "ContractorTaskWorkspaceRuntimeUnavailable",
  });
});
