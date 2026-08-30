import assert from "node:assert/strict";
import test from "node:test";

import { PortalService } from "../../../modules/external-portal/application/service.ts";
import type { PortalRepository, PortalSessionRecord } from "../../../modules/external-portal/application/repository-port.ts";

const organizationId = "11111111-1111-4111-8111-111111111111";
const caseId = "22222222-2222-4222-8222-222222222222";
const grantId = "33333333-3333-4333-8333-333333333333";
const viewerId = "44444444-4444-4444-8444-444444444444";
const relationshipId = "55555555-5555-4555-8555-555555555555";
const accessKey = `p1.${organizationId}.${caseId}.${grantId}.${"s".repeat(43)}`;

function session(input: { readonly sessionId: string }): PortalSessionRecord {
  return {
    id: input.sessionId,
    organizationId,
    serviceCaseId: caseId,
    grantId,
    status: "active",
    createdAtMs: 1_000,
    lastSeenAtMs: 1_000,
    idleExpiresAtMs: 901_000,
    absoluteExpiresAtMs: 28_801_000,
    recordVersion: 1,
  };
}

test("redeem replay returns the same session cookie material", async () => {
  const calls: string[] = [];
  const repository = {
    redeemAccess: async (input: { readonly sessionId: string }) => {
      calls.push(input.sessionId);
      return session(input);
    },
  } as unknown as PortalRepository;
  const service = new PortalService({ repository, secretPepper: "p".repeat(32), clock: { nowMs: () => 1_000 } });
  const input = { accessKey, idempotencyKey: "redeem-1", requestId: "request-1" };

  const first = await service.redeem(input);
  const replay = await service.redeem(input);

  assert.deepEqual(replay, first);
  assert.equal(calls.length, 2);
  assert.equal(calls[0], calls[1]);
});

test("Primary Advisor ensures a Case-scoped Guardian viewer without exposing CRM data", async () => {
  let observed: Parameters<NonNullable<PortalRepository["ensureViewer"]>>[0] | undefined;
  const repository = {
    ensureViewer: async (input: Parameters<NonNullable<PortalRepository["ensureViewer"]>>[0]) => {
      observed = input;
      return {
        id: input.viewerId,
        organizationId: input.organizationId,
        serviceCaseId: input.serviceCaseId,
        guardianRelationshipId: input.guardianRelationshipId,
        status: "active" as const,
        recordVersion: 1,
      };
    },
  } as unknown as PortalRepository;
  const ids = [
    viewerId,
    "66666666-6666-4666-8666-666666666666",
    "77777777-7777-4777-8777-777777777777",
  ];
  const service = new PortalService({
    repository,
    secretPepper: "p".repeat(32),
    clock: { nowMs: () => 1_000 },
    createId: () => ids.shift()!,
  });

  const result = await service.ensureViewer({
    actor: {
      actorUserId: grantId,
      organizationId,
      workspaceCapabilities: ["cases.workflow.manage"],
      roles: ["advisor"],
    },
    serviceCaseId: caseId,
    guardianRelationshipId: relationshipId,
    idempotencyKey: "ensure-viewer-1",
    requestId: "request-viewer-1",
  });

  assert.equal(result.id, viewerId);
  assert.equal(observed?.guardianRelationshipId, relationshipId);
  assert.equal(observed?.effects.audit.resourceType, "portal_viewer");
  assert.equal(observed?.effects.audit.eventType, "portal.viewer.ensure");
  assert.equal("displayName" in (observed ?? {}), false);
});
