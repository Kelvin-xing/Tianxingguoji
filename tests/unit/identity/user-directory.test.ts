import assert from "node:assert/strict";
import test from "node:test";

import {
  UserDirectoryService,
  UserDirectoryServiceError,
  type UserDirectoryRepository,
} from "../../../modules/identity/application/user-directory.ts";

const ACTOR = Object.freeze({
  userId: "10000000-0000-4000-8000-000000000001",
  organizationId: "20000000-0000-4000-8000-000000000001",
  workspaceCapabilities: ["access.manage"] as const,
});

test("user directory requires the request-time access.manage capability", async () => {
  const repository: UserDirectoryRepository = {
    async listUsers() {
      throw new Error("repository must not be called");
    },
  };
  const service = new UserDirectoryService(repository);

  await assert.rejects(
    service.listUsers({
      ...ACTOR,
      workspaceCapabilities: ["today.read"],
    }),
    (error: unknown) => error instanceof UserDirectoryServiceError && error.code === "FORBIDDEN",
  );
});

test("user directory passes the resolved organization and actor to the repository", async () => {
  let received: { readonly organizationId: string; readonly actorUserId: string } | null = null;
  const repository: UserDirectoryRepository = {
    async listUsers(input) {
      received = input;
      return Object.freeze([]);
    },
  };
  const service = new UserDirectoryService(repository);

  const result = await service.listUsers(ACTOR);

  assert.deepEqual(received, {
    organizationId: ACTOR.organizationId,
    actorUserId: ACTOR.userId,
  });
  assert.deepEqual(result, []);
});
