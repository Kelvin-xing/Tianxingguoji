import assert from "node:assert/strict";
import test from "node:test";

import {
  MemberManagementError,
  MemberManagementService,
  type MemberManagementRepository,
} from "../../../modules/access/application/member-management.ts";

const ACTOR = Object.freeze({
  userId: "10000000-0000-4000-8000-000000000001",
  organizationId: "20000000-0000-4000-8000-000000000001",
  membershipId: "30000000-0000-4000-8000-000000000001",
  roles: ["founder"] as const,
  workspaceCapabilities: ["access.manage"] as const,
  authorizationVersion: "authorization-v1",
});
const TARGET = "10000000-0000-4000-8000-000000000002";
const ACCESS_VERSION = "v1:1:0:none";

test("member access update requires request-time access.manage", async () => {
  const service = serviceWith(repositoryThatMustNotMutate());
  await assert.rejects(async () => service.updateMemberAccess({
    actor: { ...ACTOR, workspaceCapabilities: ["today.read"] },
    targetUserId: TARGET,
    command: memberCommand(),
  }), (error: unknown) => error instanceof MemberManagementError && error.code === "FORBIDDEN");
});

test("member access update rejects Contractor combinations before persistence", async () => {
  const service = serviceWith(repositoryThatMustNotMutate());
  await assert.rejects(async () => service.updateMemberAccess({
    actor: ACTOR,
    targetUserId: TARGET,
    command: { ...memberCommand(), roles: ["admin", "contractor"] },
  }), (error: unknown) => error instanceof MemberManagementError && error.code === "ROLE_CONFLICT");
});

test("member access update passes a normalized atomic role set to the repository", async () => {
  let received: Parameters<MemberManagementRepository["updateMemberAccess"]>[0] | null = null;
  const repository = repositoryThatMustNotMutate();
  repository.updateMemberAccess = async (input) => {
    received = input;
    return { userId: input.targetUserId, receiptId: "40000000-0000-4000-8000-000000000001", replayed: false };
  };
  const service = serviceWith(repository);
  await service.updateMemberAccess({ actor: ACTOR, targetUserId: TARGET,
    command: { ...memberCommand(), displayName: "  Test Advisor  ", roles: ["advisor", "admin"] } });

  const actual = received as Parameters<MemberManagementRepository["updateMemberAccess"]>[0] | null;
  assert.ok(actual);
  assert.equal(actual.displayName, "Test Advisor");
  assert.deepEqual(actual.roles, ["admin", "advisor"]);
  assert.equal(actual.employmentType, "FULL_TIME");
  assert.equal(actual.expectedAccessVersion, ACCESS_VERSION);
});

test("own profile command can only carry the actor display name and profile version", async () => {
  let received: Parameters<MemberManagementRepository["updateOwnDisplayName"]>[0] | null = null;
  const repository = repositoryThatMustNotMutate();
  repository.updateOwnDisplayName = async (input) => {
    received = input;
    return { userId: input.actorUserId, receiptId: "40000000-0000-4000-8000-000000000002", replayed: false };
  };
  const service = serviceWith(repository);
  await service.updateOwnDisplayName({
    actor: { ...ACTOR, workspaceCapabilities: ["today.read"] },
    command: { displayName: "  My Name  ", expectedProfileRecordVersion: 2,
      requestId: "request-own-1", idempotencyKey: "own-profile-1" },
  });

  const actual = received as Parameters<MemberManagementRepository["updateOwnDisplayName"]>[0] | null;
  assert.ok(actual);
  assert.equal(actual.actorUserId, ACTOR.userId);
  assert.equal(actual.displayName, "My Name");
  assert.equal(actual.expectedProfileRecordVersion, 2);
  assert.equal("roles" in actual, false);
  assert.equal("employmentType" in actual, false);
});

function memberCommand() {
  return Object.freeze({
    displayName: "Test User",
    employmentType: "FULL_TIME" as const,
    roles: ["advisor"] as readonly string[],
    expectedAccessVersion: ACCESS_VERSION,
    requestId: "request-member-1",
    idempotencyKey: "member-access-1",
  });
}

function serviceWith(repository: MemberManagementRepository) {
  let next = 1;
  return new MemberManagementService({
    repository,
    createId: () => `50000000-0000-4000-8000-${String(next++).padStart(12, "0")}`,
    now: () => Date.parse("2026-08-28T00:00:00.000Z"),
  });
}

function repositoryThatMustNotMutate(): MemberManagementRepository {
  return {
    async getOwnProfile() { throw new Error("not used"); },
    async updateOwnDisplayName() { throw new Error("repository must not be called"); },
    async updateMemberAccess() { throw new Error("repository must not be called"); },
  };
}
