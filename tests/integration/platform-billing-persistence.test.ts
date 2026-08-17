import assert from "node:assert/strict";
import test from "node:test";

import { BillingContractError } from "../../modules/platform-billing/domain/contract.ts";
import { PlatformBillingPersistenceError } from "../../modules/platform-billing/application/repository-port.ts";
import {
  getPlatformBillingRuntime,
  PlatformBillingRuntimeUnavailable,
} from "../../modules/platform-billing/infrastructure/runtime.ts";
import { FakePlatformBillingRepository } from "../fakes/platform-billing-repository.ts";

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";

test("production runtime fails closed without an installed HK RDS adapter", () => {
  assert.throws(getPlatformBillingRuntime, PlatformBillingRuntimeUnavailable);
});

test("projection ingestion is idempotent and rejects every non-contract field", async () => {
  const repository = new FakePlatformBillingRepository();
  const event = repository.caseEvent("event-1", { stage: "background_collection" });

  await repository.ingestCaseLifecycleEvent({ event, idempotencyKey: "event-key-1", requestHash: "a".repeat(64) });
  await repository.ingestCaseLifecycleEvent({ event, idempotencyKey: "event-key-1", requestHash: "a".repeat(64) });
  assert.equal(repository.snapshot().projectionEvents, 1);

  await assert.rejects(
    repository.ingestCaseLifecycleEvent({
      event: { ...event, studentName: "must-not-cross-plane" },
      idempotencyKey: "event-key-2",
      requestHash: "b".repeat(64),
    }),
    (error: unknown) => error instanceof BillingContractError && error.code === "BILLING_EVENT_PII_FORBIDDEN",
  );
  assert.doesNotMatch(repository.serializedState(), /studentName|must-not-cross-plane/);
});

test("snapshot close is count-only, pins the HK cutoff/checkpoint, and revisions append", async () => {
  const repository = new FakePlatformBillingRepository();
  for (const [index, stage] of (["background_collection", "closed"] as const).entries()) {
    await repository.ingestCaseLifecycleEvent({
      event: repository.caseEvent(`event-${index}`, { caseIdSuffix: String(index + 1), stage }),
      idempotencyKey: `event-key-${index}`,
      requestHash: String(index + 1).repeat(64),
    });
  }

  const first = await repository.closeMonthlySnapshot({
    actor: repository.finance,
    organizationId: ORGANIZATION_ID,
    billingMonth: "2026-08",
    sourceProjectionVersion: 2,
    expectedRevision: 0,
    idempotencyKey: "snapshot-1",
    requestHash: "c".repeat(64),
  });
  assert.deepEqual(
    { count: first.advancingCaseCount, cutoff: first.sourceCutoffAt, revision: first.revision },
    { count: 1, cutoff: "2026-08-31T15:59:59.999Z", revision: 1 },
  );
  assert.equal("amountMinor" in first, false);

  const corrected = await repository.closeMonthlySnapshot({
    actor: repository.finance,
    organizationId: ORGANIZATION_ID,
    billingMonth: "2026-08",
    sourceProjectionVersion: 2,
    expectedRevision: 1,
    idempotencyKey: "snapshot-2",
    requestHash: "d".repeat(64),
  });
  assert.equal(corrected.revision, 2);
  assert.equal(repository.snapshot().metricSnapshots, 2);
});

test("contract activation enforces version, distinct approver, replay, and append-only audit", async () => {
  const repository = new FakePlatformBillingRepository();
  const draft = await repository.createContractDraft({
    actor: repository.finance,
    contractId: "40000000-0000-4000-8000-000000000001",
    organizationId: ORGANIZATION_ID,
    contractNumber: "HK-2026-001",
    currency: "HKD",
    contractValueMinor: 250000,
    effectiveFrom: "2026-08-01T00:00:00.000Z",
    effectiveTo: null,
    sourceReference: "approved-source-1",
    idempotencyKey: "contract-draft-1",
    requestHash: "e".repeat(64),
  });

  await assert.rejects(
    repository.activateContract({
      actor: { ...repository.approver, actorId: repository.finance.actorId },
      contractId: draft.id,
      expectedRecordVersion: 1,
      idempotencyKey: "activate-self",
      requestHash: "f".repeat(64),
    }),
    (error: unknown) => error instanceof BillingContractError && error.code === "BILLING_SELF_APPROVAL_DENIED",
  );

  const active = await repository.activateContract({
    actor: repository.approver,
    contractId: draft.id,
    expectedRecordVersion: 1,
    idempotencyKey: "activate-1",
    requestHash: "1".repeat(64),
  });
  const replay = await repository.activateContract({
    actor: repository.approver,
    contractId: draft.id,
    expectedRecordVersion: 1,
    idempotencyKey: "activate-1",
    requestHash: "1".repeat(64),
  });
  assert.deepEqual(replay, active);
  assert.equal(active.status, "active");
  assert.equal(repository.snapshot().platformAuditEvents, 2);

  await assert.rejects(
    repository.activateContract({
      actor: repository.approver,
      contractId: draft.id,
      expectedRecordVersion: 1,
      idempotencyKey: "activate-stale",
      requestHash: "2".repeat(64),
    }),
    (error: unknown) => error instanceof PlatformBillingPersistenceError && error.code === "BILLING_VERSION_CONFLICT",
  );
});

test("conflicting replay and platform-audit failure leave no partial business state", async () => {
  const repository = new FakePlatformBillingRepository();
  const command = {
    actor: repository.finance,
    contractId: "40000000-0000-4000-8000-000000000002",
    organizationId: ORGANIZATION_ID,
    contractNumber: "HK-2026-002",
    currency: "HKD" as const,
    contractValueMinor: 1,
    effectiveFrom: "2027-08-01T00:00:00.000Z",
    effectiveTo: null,
    sourceReference: "approved-source-2",
    idempotencyKey: "contract-draft-2",
    requestHash: "3".repeat(64),
  };
  await repository.createContractDraft(command);
  await assert.rejects(
    repository.createContractDraft({ ...command, requestHash: "4".repeat(64) }),
    (error: unknown) => error instanceof PlatformBillingPersistenceError && error.code === "BILLING_IDEMPOTENCY_CONFLICT",
  );

  repository.failPlatformAudit = true;
  await assert.rejects(repository.createContractDraft({
    ...command,
    contractId: "40000000-0000-4000-8000-000000000003",
    contractNumber: "HK-2026-003",
    idempotencyKey: "contract-draft-3",
    requestHash: "5".repeat(64),
  }));
  assert.equal(repository.snapshot().contracts, 1);
});
