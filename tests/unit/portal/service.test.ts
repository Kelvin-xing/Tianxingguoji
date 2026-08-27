import assert from "node:assert/strict";
import test from "node:test";

import { PortalService } from "../../../modules/external-portal/application/service.ts";
import type { PortalRepository, PortalSessionRecord } from "../../../modules/external-portal/application/repository-port.ts";

const organizationId = "11111111-1111-4111-8111-111111111111";
const caseId = "22222222-2222-4222-8222-222222222222";
const grantId = "33333333-3333-4333-8333-333333333333";
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
