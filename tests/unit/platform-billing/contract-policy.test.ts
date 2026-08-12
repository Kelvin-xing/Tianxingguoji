import assert from "node:assert/strict";
import test from "node:test";

import {
  ADVANCING_CASE_COUNT_POLICY_VERSION,
  ADVANCING_CASE_STAGES,
  BillingContractError,
  buildAdvancingCaseCount,
  createCustomerContractVersion,
  evaluateContractEffectivePeriod,
  parseCaseLifecycleProjectionEvent,
  resolveBillingMonthCutoff,
} from "../../../modules/platform-billing/contract.ts";
import {
  evaluateContractActivation,
  evaluateContractDraftCreation,
  evaluatePlatformBillingExport,
  evaluatePlatformBillingOperation,
  projectSubscriptionStatus,
  type PlatformBillingActor,
} from "../../../modules/platform-billing/policy.ts";

const ids = Object.freeze({
  organization: "11111111-1111-4111-8111-111111111111",
  caseA: "22222222-2222-4222-8222-222222222222",
  caseB: "33333333-3333-4333-8333-333333333333",
});

function event(input: {
  readonly eventId: string;
  readonly caseId: string;
  readonly stage: string;
  readonly effectiveAt: string;
  readonly caseVersion: number;
}): Record<string, unknown> {
  return {
    eventId: input.eventId,
    organizationId: ids.organization,
    caseId: input.caseId,
    stage: input.stage,
    effectiveAt: input.effectiveAt,
    caseVersion: input.caseVersion,
  };
}

test("DP-06 advancing_case_count_v1 uses approved stages at the Hong Kong month cutoff", () => {
  assert.deepEqual(ADVANCING_CASE_STAGES, [
    "background_collection",
    "school_selection_confirmed",
    "interview_preparation",
    "application_submitted",
    "awaiting_result",
    "offer_confirmed",
  ]);
  assert.equal(
    resolveBillingMonthCutoff("2026-08"),
    "2026-08-31T15:59:59.999Z",
  );

  const snapshot = buildAdvancingCaseCount({
    organizationId: ids.organization,
    billingMonth: "2026-08",
    projectionComplete: true,
    events: [
      event({
        eventId: "event-a-1",
        caseId: ids.caseA,
        stage: "signed",
        effectiveAt: "2026-08-01T00:00:00.000Z",
        caseVersion: 1,
      }),
      event({
        eventId: "event-a-2",
        caseId: ids.caseA,
        stage: "background_collection",
        effectiveAt: "2026-08-31T15:59:59.999Z",
        caseVersion: 2,
      }),
      event({
        eventId: "event-b-1",
        caseId: ids.caseB,
        stage: "offer_confirmed",
        effectiveAt: "2026-08-30T00:00:00.000Z",
        caseVersion: 1,
      }),
      event({
        eventId: "event-b-2",
        caseId: ids.caseB,
        stage: "closed",
        effectiveAt: "2026-08-31T16:00:00.000Z",
        caseVersion: 2,
      }),
    ],
  });

  assert.deepEqual(snapshot, {
    organizationId: ids.organization,
    billingMonth: "2026-08",
    sourceCutoffAt: "2026-08-31T15:59:59.999Z",
    countPolicyVersion: ADVANCING_CASE_COUNT_POLICY_VERSION,
    advancingCaseCount: 2,
  });
});

test("DP-06 lifecycle projection rejects unknown, incomplete, and PII-bearing events", () => {
  assertBillingContractError(
    () => parseCaseLifecycleProjectionEvent(event({
      eventId: "event-unknown-stage",
      caseId: ids.caseA,
      stage: "paused",
      effectiveAt: "2026-08-01T00:00:00.000Z",
      caseVersion: 1,
    })),
    "BILLING_EVENT_STAGE_UNKNOWN",
  );

  const incomplete = event({
    eventId: "event-incomplete",
    caseId: ids.caseA,
    stage: "signed",
    effectiveAt: "2026-08-01T00:00:00.000Z",
    caseVersion: 1,
  });
  delete incomplete.caseId;
  assertBillingContractError(
    () => parseCaseLifecycleProjectionEvent(incomplete),
    "BILLING_EVENT_INCOMPLETE",
  );

  assertBillingContractError(
    () => parseCaseLifecycleProjectionEvent({
      ...event({
        eventId: "event-with-pii",
        caseId: ids.caseA,
        stage: "signed",
        effectiveAt: "2026-08-01T00:00:00.000Z",
        caseVersion: 1,
      }),
      studentName: "must not cross the module boundary",
    }),
    "BILLING_EVENT_PII_FORBIDDEN",
  );
});

test("DP-06 projection replay is idempotent, conflict-detecting, and permutation-stable", () => {
  const first = event({
    eventId: "event-a-1",
    caseId: ids.caseA,
    stage: "signed",
    effectiveAt: "2026-08-01T00:00:00.000Z",
    caseVersion: 1,
  });
  const second = event({
    eventId: "event-a-2",
    caseId: ids.caseA,
    stage: "awaiting_result",
    effectiveAt: "2026-08-02T00:00:00.000Z",
    caseVersion: 2,
  });

  const build = (events: readonly unknown[]) => buildAdvancingCaseCount({
    organizationId: ids.organization,
    billingMonth: "2026-08",
    projectionComplete: true,
    events,
  });

  const expected = build([first, second]);
  assert.deepEqual(build([first, second, { ...second }]), expected);
  assert.deepEqual(build([second, first]), expected);
  assert.deepEqual(build([{ ...second }, first, second]), expected);

  assertBillingContractError(
    () => build([second, { ...second, stage: "closed" }]),
    "BILLING_EVENT_CONFLICT",
  );
  assertBillingContractError(
    () => build([second, { ...second, eventId: "event-a-2-conflict", stage: "closed" }]),
    "BILLING_EVENT_CONFLICT",
  );
});

test("DP-07 contract values are immutable opaque integer minor-unit facts", () => {
  const contract = createCustomerContractVersion({
    id: "44444444-4444-4444-8444-444444444444",
    organizationId: ids.organization,
    contractNumber: "HK-2026-001",
    currency: "HKD",
    contractValueMinor: 12_345_678,
    effectiveFrom: "2026-08-01T00:00:00.000Z",
    effectiveTo: null,
    sourceReference: "approved-contract-2026-001",
    createdByActorId: "55555555-5555-4555-8555-555555555555",
    approvedByActorId: "66666666-6666-4666-8666-666666666666",
    approvedAt: "2026-07-31T09:00:00.000Z",
    recordVersion: 1,
  });

  assert.equal(contract.currency, "HKD");
  assert.equal(contract.contractValueMinor, 12_345_678);
  assert.equal("monthlyFeeMinor" in contract, false);
  assert.equal("totalMinor" in contract, false);
  assert.equal(Object.isFrozen(contract), true);

  for (const contractValueMinor of [1.5, -1, Number.MAX_SAFE_INTEGER + 1]) {
    assertBillingContractError(
      () => createCustomerContractVersion({ ...contract, contractValueMinor }),
      "BILLING_CONTRACT_VALUE_INVALID",
    );
  }
  for (const currency of ["hkd", "HK", "ZZZ"]) {
    assertBillingContractError(
      () => createCustomerContractVersion({ ...contract, currency }),
      "BILLING_CONTRACT_CURRENCY_INVALID",
    );
  }
  assertBillingContractError(
    () => createCustomerContractVersion({
      ...contract,
      effectiveTo: "2026-07-31T23:59:59.999Z",
    }),
    "BILLING_CONTRACT_EFFECTIVE_RANGE_INVALID",
  );
  assertBillingContractError(
    () => createCustomerContractVersion({
      ...contract,
      approvedByActorId: contract.createdByActorId,
    }),
    "BILLING_SELF_APPROVAL_DENIED",
  );
});

test("DP-07 contract effective periods reject overlap and permit adjacent versions", () => {
  const existing = [{
    effectiveFrom: "2026-01-01T00:00:00.000Z",
    effectiveTo: "2026-07-31T23:59:59.999Z",
  }] as const;

  assert.deepEqual(evaluateContractEffectivePeriod({
    proposed: {
      effectiveFrom: "2026-08-01T00:00:00.000Z",
      effectiveTo: null,
    },
    existing,
  }), { allowed: true });
  assert.deepEqual(evaluateContractEffectivePeriod({
    proposed: {
      effectiveFrom: "2026-07-31T23:59:59.999Z",
      effectiveTo: null,
    },
    existing,
  }), {
    allowed: false,
    code: "BILLING_CONTRACT_EFFECTIVE_PERIOD_OVERLAP",
  });
});

test("DP-08 contract mutation requires active segregated platform actors and denies export", () => {
  const finance = platformActor("platform_finance", "55555555-5555-4555-8555-555555555555");
  const approver = platformActor(
    "platform_billing_approver",
    "66666666-6666-4666-8666-666666666666",
  );

  assert.deepEqual(evaluateContractDraftCreation(finance), { allowed: true });
  assert.deepEqual(evaluateContractActivation({
    creatorActorId: finance.actorId,
    approver,
  }), { allowed: true });
  assert.deepEqual(evaluateContractActivation({
    creatorActorId: approver.actorId,
    approver,
  }), {
    allowed: false,
    code: "BILLING_SELF_APPROVAL_DENIED",
  });

  for (const actor of [
    platformActor("platform_admin"),
    platformActor("tenant_founder"),
    { ...finance, status: "disabled" as const },
  ]) {
    assert.deepEqual(evaluateContractDraftCreation(actor), {
      allowed: false,
      code: "BILLING_COMMAND_DENIED",
    });
  }
  assert.deepEqual(evaluatePlatformBillingExport(approver), {
    allowed: false,
    code: "BILLING_EXPORT_DENIED",
  });
});

test("DP-07/09/10/11/12 unresolved operations fail closed with stable codes", () => {
  for (const operation of [
    "calculate_payable_amount",
    "generate_notice",
    "approve_notice",
    "deliver_notice",
    "record_manual_receipt",
  ] as const) {
    assert.deepEqual(evaluatePlatformBillingOperation(operation), {
      allowed: false,
      code: "BILLING_POLICY_UNAVAILABLE",
    });
  }
  assert.deepEqual(evaluatePlatformBillingOperation("purge_record"), {
    allowed: false,
    code: "BILLING_RETENTION_PENDING",
  });
  assert.deepEqual(evaluatePlatformBillingOperation("activate_second_tenant"), {
    allowed: false,
    code: "BILLING_SECOND_TENANT_UNAVAILABLE",
  });
  for (const operation of ["suspend_subscription", "terminate_subscription"] as const) {
    assert.deepEqual(evaluatePlatformBillingOperation(operation), {
      allowed: false,
      code: "BILLING_SUBSCRIPTION_TRANSITION_UNAVAILABLE",
    });
  }
});

test("DP-09 past_due is an aggregate-only exception with no authorization effect", () => {
  assert.deepEqual(projectSubscriptionStatus("active"), {
    status: "active",
    aggregateException: null,
    authorizationEffect: "none",
  });
  assert.deepEqual(projectSubscriptionStatus("past_due"), {
    status: "past_due",
    aggregateException: "past_due",
    authorizationEffect: "none",
  });
  for (const status of ["suspended", "terminated"] as const) {
    assertBillingContractError(
      () => projectSubscriptionStatus(status),
      "BILLING_SUBSCRIPTION_TRANSITION_UNAVAILABLE",
    );
  }
});

function assertBillingContractError(
  action: () => unknown,
  code: BillingContractError["code"],
): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof BillingContractError);
    assert.equal(error.code, code);
    return true;
  });
}

function platformActor(
  role: PlatformBillingActor["role"],
  actorId = "77777777-7777-4777-8777-777777777777",
): PlatformBillingActor {
  return { actorId, role, status: "active" };
}
