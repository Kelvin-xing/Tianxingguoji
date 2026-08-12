import assert from "node:assert/strict";
import test from "node:test";

import { AccessScopeError, AccessScopeService } from "../../modules/access/service.ts";
import { InMemoryCollaboratorScopeRepository } from "../fakes/collaborator-scope.ts";

const PRIMARY_ADVISOR = Object.freeze({
  userId: "11111111-1111-4111-8111-111111111111",
  organizationId: "22222222-2222-4222-8222-222222222222",
  role: "advisor" as const,
  sessionId: "33333333-3333-4333-8333-333333333333",
  capturedSessionVersion: 1,
  reauthenticatedAtMs: 1_754_265_600_000,
});
const COLLABORATOR_USER_ID = "44444444-4444-4444-8444-444444444444";
const CASE_ID = "55555555-5555-4555-8555-555555555555";

class FixedClock {
  nowMs(): number {
    return 1_754_265_600_000;
  }
}

test("a Primary Advisor grants one active ordinary scope with a seven-day boundary", async () => {
  const repository = new InMemoryCollaboratorScopeRepository();
  repository.activateCase({ caseId: CASE_ID, organizationId: PRIMARY_ADVISOR.organizationId });
  repository.assignPrimaryAdvisor({
    caseId: CASE_ID,
    organizationId: PRIMARY_ADVISOR.organizationId,
    userId: PRIMARY_ADVISOR.userId,
  });
  repository.activateAdvisor({
    organizationId: PRIMARY_ADVISOR.organizationId,
    userId: COLLABORATOR_USER_ID,
  });
  const service = new AccessScopeService({
    repository,
    clock: new FixedClock(),
    createId: sequenceIds(100),
  });

  const result = await service.grantCollaboratorScope({
    actor: PRIMARY_ADVISOR,
    caseId: CASE_ID,
    command: {
      collaboratorUserId: COLLABORATOR_USER_ID,
      scope: "case_summary",
      capability: "edit",
      expiresAtMs: null,
      requestReason: null,
      requestId: "request-p1-06-grant-001",
      idempotencyKey: "collaborator-grant-p1-06-001",
    },
  });

  assert.deepEqual(result, {
    collaboratorId: "00000000-0000-4000-8000-000000000101",
    grantId: "00000000-0000-4000-8000-000000000102",
    scope: "case_summary",
    capability: "edit",
    status: "active",
    startsAtMs: 1_754_265_600_000,
    expiresAtMs: 1_754_870_400_000,
    recordVersion: 1,
  });
  assert.deepEqual(repository.snapshot(), {
    collaborators: 1,
    grants: 1,
    audits: 1,
    outbox: 1,
  });
  assert.deepEqual(
    repository.evaluateGrant({
      caseId: CASE_ID,
      organizationId: PRIMARY_ADVISOR.organizationId,
      userId: COLLABORATOR_USER_ID,
      scope: "case_summary",
      capability: "edit",
    }),
    { allowed: true },
  );
  assert.deepEqual(
    repository.evaluateGrant({
      caseId: CASE_ID,
      organizationId: PRIMARY_ADVISOR.organizationId,
      userId: COLLABORATOR_USER_ID,
      scope: "case_summary",
      capability: "edit",
      nowMs: result.expiresAtMs,
    }),
    { allowed: false, code: "GRANT_EXPIRED" },
  );
  assert.deepEqual(
    repository.evaluateGrant({
      caseId: CASE_ID,
      organizationId: PRIMARY_ADVISOR.organizationId,
      userId: COLLABORATOR_USER_ID,
      scope: "case_summary",
      capability: "export",
    }),
    { allowed: false, code: "COLLABORATOR_EXPORT_DENIED" },
  );
});

test("a Primary Advisor revokes a scope immediately with an optimistic version", async () => {
  const repository = new InMemoryCollaboratorScopeRepository();
  repository.activateCase({ caseId: CASE_ID, organizationId: PRIMARY_ADVISOR.organizationId });
  repository.assignPrimaryAdvisor({
    caseId: CASE_ID,
    organizationId: PRIMARY_ADVISOR.organizationId,
    userId: PRIMARY_ADVISOR.userId,
  });
  repository.activateAdvisor({
    organizationId: PRIMARY_ADVISOR.organizationId,
    userId: COLLABORATOR_USER_ID,
  });
  const service = new AccessScopeService({
    repository,
    clock: new FixedClock(),
    createId: sequenceIds(100),
  });
  const grant = await service.grantCollaboratorScope({
    actor: PRIMARY_ADVISOR,
    caseId: CASE_ID,
    command: {
      collaboratorUserId: COLLABORATOR_USER_ID,
      scope: "case_summary",
      capability: "edit",
      expiresAtMs: null,
      requestReason: null,
      requestId: "request-p1-06-grant-002",
      idempotencyKey: "collaborator-grant-p1-06-002",
    },
  });

  const revoked = await service.revokeCollaboratorScope({
    actor: PRIMARY_ADVISOR,
    caseId: CASE_ID,
    collaboratorId: grant.collaboratorId,
    grantId: grant.grantId,
    command: {
      expectedRecordVersion: 1,
      reason: "case_reassigned",
      requestId: "request-p1-06-revoke-001",
      idempotencyKey: "collaborator-revoke-p1-06-001",
    },
  });

  assert.deepEqual(revoked, {
    collaboratorId: grant.collaboratorId,
    grantId: grant.grantId,
    status: "revoked",
    recordVersion: 2,
  });
  assert.deepEqual(
    repository.evaluateGrant({
      caseId: CASE_ID,
      organizationId: PRIMARY_ADVISOR.organizationId,
      userId: COLLABORATOR_USER_ID,
      scope: "case_summary",
      capability: "edit",
    }),
    { allowed: false, code: "GRANT_NOT_ACTIVE" },
  );
  assert.deepEqual(repository.snapshot(), {
    collaborators: 1,
    grants: 1,
    audits: 2,
    outbox: 2,
  });
});

test("a repeated grant returns its first result, while changed key reuse is rejected", async () => {
  const repository = new InMemoryCollaboratorScopeRepository();
  repository.activateCase({ caseId: CASE_ID, organizationId: PRIMARY_ADVISOR.organizationId });
  repository.assignPrimaryAdvisor({
    caseId: CASE_ID,
    organizationId: PRIMARY_ADVISOR.organizationId,
    userId: PRIMARY_ADVISOR.userId,
  });
  repository.activateAdvisor({
    organizationId: PRIMARY_ADVISOR.organizationId,
    userId: COLLABORATOR_USER_ID,
  });
  const service = new AccessScopeService({
    repository,
    clock: new FixedClock(),
    createId: sequenceIds(100),
  });
  const input = {
    actor: PRIMARY_ADVISOR,
    caseId: CASE_ID,
    command: {
      collaboratorUserId: COLLABORATOR_USER_ID,
      scope: "case_summary" as const,
      capability: "view" as const,
      expiresAtMs: null,
      requestReason: null,
      requestId: "request-p1-06-grant-003",
      idempotencyKey: "collaborator-grant-p1-06-003",
    },
  };

  const first = await service.grantCollaboratorScope(input);
  assert.deepEqual(await service.grantCollaboratorScope(input), first);
  assert.deepEqual(repository.snapshot(), {
    collaborators: 1,
    grants: 1,
    audits: 1,
    outbox: 1,
  });
  await assert.rejects(
    service.grantCollaboratorScope({
      ...input,
      command: { ...input.command, capability: "edit" },
    }),
    accessScopeError("COLLABORATOR_SCOPE_IDEMPOTENCY_KEY_REUSED"),
  );
});

test("a sensitive scope persists pending approval and cannot authorize access", async () => {
  const repository = new InMemoryCollaboratorScopeRepository();
  repository.activateCase({ caseId: CASE_ID, organizationId: PRIMARY_ADVISOR.organizationId });
  repository.assignPrimaryAdvisor({
    caseId: CASE_ID,
    organizationId: PRIMARY_ADVISOR.organizationId,
    userId: PRIMARY_ADVISOR.userId,
  });
  repository.activateAdvisor({
    organizationId: PRIMARY_ADVISOR.organizationId,
    userId: COLLABORATOR_USER_ID,
  });
  const service = new AccessScopeService({
    repository,
    clock: new FixedClock(),
    createId: sequenceIds(200),
  });

  const pending = await service.grantCollaboratorScope({
    actor: PRIMARY_ADVISOR,
    caseId: CASE_ID,
    command: {
      collaboratorUserId: COLLABORATOR_USER_ID,
      scope: "identity_contact",
      capability: "view",
      expiresAtMs: 1_754_351_200_000,
      requestReason: "guardian_contact_confirmation",
      requestId: "request-p1-06-grant-004",
      idempotencyKey: "collaborator-grant-p1-06-004",
    },
  });

  assert.equal(pending.status, "pending_approval");
  assert.deepEqual(
    repository.evaluateGrant({
      caseId: CASE_ID,
      organizationId: PRIMARY_ADVISOR.organizationId,
      userId: COLLABORATOR_USER_ID,
      scope: "identity_contact",
      capability: "view",
    }),
    { allowed: false, code: "GRANT_NOT_ACTIVE" },
  );
});

test("an overlong scope and a non-Primary Advisor are denied without partial facts", async () => {
  const repository = new InMemoryCollaboratorScopeRepository();
  repository.activateCase({ caseId: CASE_ID, organizationId: PRIMARY_ADVISOR.organizationId });
  repository.assignPrimaryAdvisor({
    caseId: CASE_ID,
    organizationId: PRIMARY_ADVISOR.organizationId,
    userId: PRIMARY_ADVISOR.userId,
  });
  repository.activateAdvisor({
    organizationId: PRIMARY_ADVISOR.organizationId,
    userId: COLLABORATOR_USER_ID,
  });
  const service = new AccessScopeService({
    repository,
    clock: new FixedClock(),
    createId: sequenceIds(300),
  });
  const command = {
    collaboratorUserId: COLLABORATOR_USER_ID,
    scope: "school_targets" as const,
    capability: "view" as const,
    expiresAtMs: 1_754_870_400_001,
    requestReason: null,
    requestId: "request-p1-06-grant-005",
    idempotencyKey: "collaborator-grant-p1-06-005",
  };

  await assert.rejects(
    service.grantCollaboratorScope({ actor: PRIMARY_ADVISOR, caseId: CASE_ID, command }),
    accessScopeError("COLLABORATOR_SCOPE_INVALID"),
  );
  await assert.rejects(
    service.grantCollaboratorScope({
      actor: { ...PRIMARY_ADVISOR, userId: "66666666-6666-4666-8666-666666666666" },
      caseId: CASE_ID,
      command: { ...command, expiresAtMs: null, idempotencyKey: "collaborator-grant-p1-06-006" },
    }),
    accessScopeError("COLLABORATOR_PRIMARY_ADVISOR_REQUIRED"),
  );
  assert.deepEqual(repository.snapshot(), {
    collaborators: 0,
    grants: 0,
    audits: 0,
    outbox: 0,
  });
});

test("a repository failure commits no collaborator, grant, audit, or outbox fact", async () => {
  const repository = new InMemoryCollaboratorScopeRepository();
  repository.activateCase({ caseId: CASE_ID, organizationId: PRIMARY_ADVISOR.organizationId });
  repository.assignPrimaryAdvisor({
    caseId: CASE_ID,
    organizationId: PRIMARY_ADVISOR.organizationId,
    userId: PRIMARY_ADVISOR.userId,
  });
  repository.activateAdvisor({
    organizationId: PRIMARY_ADVISOR.organizationId,
    userId: COLLABORATOR_USER_ID,
  });
  repository.failOnceBeforeCommit();
  const service = new AccessScopeService({
    repository,
    clock: new FixedClock(),
    createId: sequenceIds(400),
  });

  await assert.rejects(
    service.grantCollaboratorScope({
      actor: PRIMARY_ADVISOR,
      caseId: CASE_ID,
      command: {
        collaboratorUserId: COLLABORATOR_USER_ID,
        scope: "school_targets",
        capability: "view",
        expiresAtMs: null,
        requestReason: null,
        requestId: "request-p1-06-grant-007",
        idempotencyKey: "collaborator-grant-p1-06-007",
      },
    }),
    /synthetic transaction failure/,
  );
  assert.deepEqual(repository.snapshot(), {
    collaborators: 0,
    grants: 0,
    audits: 0,
    outbox: 0,
  });
});

function sequenceIds(start: number): () => string {
  let current = start;
  return () => {
    current += 1;
    return `00000000-0000-4000-8000-${String(current).padStart(12, "0")}`;
  };
}

function accessScopeError(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof AccessScopeError && error.code === code;
}
