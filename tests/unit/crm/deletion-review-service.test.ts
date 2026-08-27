import assert from "node:assert/strict";
import test from "node:test";

import {
  DeletionReviewError,
  DeletionReviewService,
  isDeletionReviewError,
  type DeletionReviewRepository,
} from "../../../modules/crm/application/deletion-review-service.ts";
import {
  workspaceCapabilitiesForRole,
  type RequestAccessActor,
} from "../../../modules/access/public.ts";
import { mergeWorkspaceCapabilities } from "../../../modules/access/public.ts";
import {
  decodeDeletionRequestLocator,
  encodeDeletionRequestLocator,
} from "../../../modules/crm/domain/deletion-request-locator.ts";
import { hashRequestPayload } from "../../../modules/shared/public.ts";

const IDS = Object.freeze({
  organization: "51000000-0000-4000-8000-000000000001",
  actor: "51000000-0000-4000-8000-000000000101",
  target: "51000000-0000-4000-8000-000000000601",
  audit: "71000000-0000-4000-8000-000000000001",
  outbox: "71000000-0000-4000-8000-000000000002",
});

test("freezes request and review capability enforcement for all five roles", async () => {
  const calls: string[] = [];
  const service = new DeletionReviewService(repository(calls));
  for (const role of ["founder", "advisor"] as const) {
    await service.requestDeletion({ actor: actor(role), command: command() });
  }
  await service.listDeletionRequests(actor("founder"), null);
  assert.deepEqual(calls, ["request", "request", "list"]);
  for (const role of ["admin", "data_reviewer", "contractor"] as const) {
    await denied(() =>
      service.requestDeletion({ actor: actor(role), command: command() }),
    );
  }
  for (const role of [
    "admin",
    "advisor",
    "data_reviewer",
    "contractor",
  ] as const) {
    await denied(() => service.listDeletionRequests(actor(role), null));
  }
});

test("hashes the exact command and emits only PII-free lifecycle effects", async () => {
  let captured:
    | Parameters<DeletionReviewRepository["requestDeletion"]>[0]
    | undefined;
  const ids = [IDS.audit, IDS.outbox];
  const service = new DeletionReviewService(
    repository([], {
      async requestDeletion(input) {
        captured = input;
        return receipt();
      },
    }),
    () => ids.shift()!,
    () => Date.parse("2026-08-23T00:00:00.000Z"),
  );
  await service.requestDeletion({
    actor: actor("founder"),
    command: command(),
  });
  assert.match(captured?.requestHash ?? "", /^[0-9a-f]{64}$/);
  assert.equal(
    captured?.reasonCode,
    "record.lifecycle.pending_delete_requested",
  );
  const effects = JSON.stringify(captured?.effects);
  for (const forbidden of [
    "Student Name",
    "student@example.invalid",
    "+85220000000",
  ]) {
    assert.equal(effects.includes(forbidden), false);
  }
  assert.equal(effects.includes("pending_delete"), true);
  assert.equal(
    captured?.effects.audit.eventType,
    "crm.soft_deletion_requested",
  );
  assert.equal(
    captured?.effects.outbox.eventType,
    "crm.soft_deletion_requested",
  );
  assert.equal(captured?.effects.outbox.payload.entity_type, "student");
});

test("stable deletion error guard accepts cross-module Error and rejects unsafe shapes", () => {
  const crossModule = new Error("redacted");
  crossModule.name = "DeletionReviewError";
  Object.defineProperty(crossModule, "code", {
    value: "DELETION_REVIEW_FORBIDDEN",
  });
  assert.equal(isDeletionReviewError(crossModule), true);
  assert.equal(
    isDeletionReviewError(crossModule, "DELETION_REVIEW_FORBIDDEN"),
    true,
  );
  assert.equal(
    isDeletionReviewError(crossModule, "DELETION_REVIEW_INVALID"),
    false,
  );
  assert.equal(
    isDeletionReviewError({
      name: "DeletionReviewError",
      code: "DELETION_REVIEW_FORBIDDEN",
    }),
    false,
  );
  const unknown = new Error("redacted");
  unknown.name = "DeletionReviewError";
  Object.defineProperty(unknown, "code", { value: "UNKNOWN" });
  assert.equal(isDeletionReviewError(unknown), false);
});

function repository(
  calls: string[],
  overrides: Partial<DeletionReviewRepository> = {},
): DeletionReviewRepository {
  return {
    async requestDeletion() {
      calls.push("request");
      return receipt();
    },
    async listDeletionRequests() {
      calls.push("list");
      return [];
    },
    async decideDeletion() {
      calls.push("decide");
      return {
        entityType: "student",
        entityId: IDS.target,
        status: "deleted",
        recordVersion: 3,
        occurredAt: "2026-08-23T00:00:00.000Z",
      };
    },
    ...overrides,
  };
}
function actor(
  role: "founder" | "admin" | "advisor" | "contractor" | "data_reviewer",
): RequestAccessActor {
  return Object.freeze({
    userId: IDS.actor,
    organizationId: IDS.organization,
    roles: role === "data_reviewer" ? [] : [role],
    workspaceCapabilities:
      role === "data_reviewer" ? [] : workspaceCapabilitiesForRole(role),
  });
}
function command() {
  return {
    entityType: "student" as const,
    entityId: IDS.target,
    expectedRecordVersion: 1,
    reasonCode: "record.lifecycle.pending_delete_requested" as const,
    requestId: "crm05-request",
    idempotencyKey: "crm05-request",
  };
}
function receipt() {
  return Object.freeze({
    entityType: "student" as const,
    entityId: IDS.target,
    status: "pending_delete" as const,
    deletionRequestedAt: "2026-08-23T00:00:00.000Z",
    recordVersion: 2,
  });
}
async function denied(action: () => Promise<unknown>) {
  await assert.rejects(
    async () => action(),
    (error: unknown) =>
      error instanceof DeletionReviewError &&
      error.code === "DELETION_REVIEW_FORBIDDEN",
  );
}

test("deletion locator is stable, typed, and canonical", () => {
  const student = encodeDeletionRequestLocator("student", IDS.target);
  const guardian = encodeDeletionRequestLocator("guardian", IDS.target);
  assert.notEqual(student, guardian);
  assert.deepEqual(decodeDeletionRequestLocator(student), {
    entityType: "student",
    entityId: IDS.target,
  });
  assert.throws(() => decodeDeletionRequestLocator(`${student}=`), /INVALID/);
  const encoded = (payload: string) =>
    `del_v1_${Buffer.from(payload).toString("base64url")}`;
  for (const malformed of [
    `wrong_${student}`,
    encoded("v1:student:5A000000-0000-4000-8000-000000000001"),
    encoded(`v2:student:${IDS.target}`),
    encoded(`v1:case:${IDS.target}`),
    encoded(`v1:student:${IDS.target}:extra`),
  ])
    assert.throws(
      () => decodeDeletionRequestLocator(malformed),
      /DELETION_LOCATOR_INVALID/,
    );
});

test("queue summaries derive frozen typed locators without repository requestId", async () => {
  const items = [
    { ...receipt(), displayLabel: "Student" },
    { ...receipt(), entityType: "guardian" as const, displayLabel: "Guardian" },
  ];
  const service = new DeletionReviewService(
    repository([], {
      async listDeletionRequests() {
        return items;
      },
    }),
  );
  const output = await service.listDeletionRequests(actor("founder"), null);
  assert.equal(Object.isFrozen(output), true);
  assert.equal(Object.isFrozen(output[0]), true);
  assert.deepEqual(decodeDeletionRequestLocator(output[0]!.requestId), {
    entityType: "student",
    entityId: IDS.target,
  });
  assert.deepEqual(decodeDeletionRequestLocator(output[1]!.requestId), {
    entityType: "guardian",
    entityId: IDS.target,
  });
  assert.equal(Object.hasOwn(items[0]!, "requestId"), false);
  const union: RequestAccessActor = {
    ...actor("founder"),
    roles: ["founder", "admin"],
    workspaceCapabilities: mergeWorkspaceCapabilities(["founder", "admin"]),
  };
  assert.ok(union.workspaceCapabilities?.includes("students.deletion.review"));
});

test("Founder decision freezes hash, ids, timestamp and PII-free effects", async () => {
  let captured:
    | Parameters<DeletionReviewRepository["decideDeletion"]>[0]
    | undefined;
  const ids = [
    "71000000-0000-4000-8000-000000000011",
    "71000000-0000-4000-8000-000000000012",
    "71000000-0000-4000-8000-000000000013",
  ];
  const service = new DeletionReviewService(
    repository([], {
      async decideDeletion(value) {
        captured = value;
        return {
          entityType: "student",
          entityId: IDS.target,
          status: "deleted",
          recordVersion: 3,
          occurredAt: value.occurredAt,
        };
      },
    }),
    () => ids.shift()!,
    () => Date.parse("2026-08-23T00:00:00.000Z"),
  );
  const result = await service.decideDeletion({
    actor: actor("founder"),
    command: {
      entityType: "student",
      entityId: IDS.target,
      decision: "approve",
      expectedRecordVersion: 2,
      correlationRequestId: "decision-request",
      idempotencyKey: "decision-key",
    },
  });
  assert.equal(result.status, "deleted");
  assert.equal(captured?.actorRole, "founder");
  assert.equal(
    captured?.requestHash,
    hashRequestPayload({
      entity_type: "student",
      entity_id: IDS.target,
      decision: "approve",
      expected_record_version: 2,
    }),
  );
  assert.equal(
    captured?.idempotencyRecordId,
    "71000000-0000-4000-8000-000000000011",
  );
  assert.equal(
    captured?.effects.audit.id,
    "71000000-0000-4000-8000-000000000012",
  );
  assert.equal(
    captured?.effects.outbox.id,
    "71000000-0000-4000-8000-000000000013",
  );
  assert.equal(captured?.occurredAt, "2026-08-23T00:00:00.000Z");
  assert.equal(captured?.effects.audit.occurredAt, captured?.occurredAt);
  assert.equal(captured?.effects.outbox.availableAt, captured?.occurredAt);
  assert.equal(captured?.effects.outbox.createdAt, captured?.occurredAt);
  assert.equal(captured?.effects.audit.eventType, "crm.soft_deletion_approved");
  assert.equal(captured?.effects.audit.action, "approve_soft_deletion");
  assert.equal(captured?.effects.audit.resourceType, "Student");
  assert.deepEqual(captured?.effects.audit.metadata, {
    entity_type: "student",
    decision: "approve",
    previous_version: 2,
    record_version: 3,
    status: "deleted",
    reason_code: "record.lifecycle.soft_deletion_approved",
    request_id: "decision-request",
  });
  assert.equal(captured?.effects.outbox.aggregateType, "Student");
  assert.equal(
    captured?.effects.outbox.eventType,
    "crm.soft_deletion_approved",
  );
  assert.deepEqual(captured?.effects.outbox.payload, {
    aggregate_id: IDS.target,
    entity_type: "student",
    decision: "approve",
    previous_version: 2,
    record_version: 3,
    status: "deleted",
    reason_code: "record.lifecycle.soft_deletion_approved",
    request_id: "decision-request",
  });
  assert.doesNotMatch(
    JSON.stringify(captured?.effects),
    /email|phone|display_name/i,
  );
  for (const role of ["admin", "advisor", "contractor"] as const)
    await denied(() =>
      service.decideDeletion({
        actor: actor(role),
        command: {
          entityType: "student",
          entityId: IDS.target,
          decision: "reject",
          expectedRecordVersion: 2,
          correlationRequestId: "decision-request",
          idempotencyKey: "decision-key",
        },
      }),
    );
});

test("canonicalizes uppercase entity UUIDs before hashing, SQL input, and receipt", async () => {
  const uppercaseId = "A1000000-ABCD-4000-8000-000000000601";
  const canonicalId = uppercaseId.toLowerCase();
  let captured:
    | Parameters<DeletionReviewRepository["decideDeletion"]>[0]
    | undefined;
  const service = new DeletionReviewService(
    repository([], {
      async decideDeletion(value) {
        captured = value;
        return {
          entityType: "student",
          entityId: value.command.entityId,
          status: "deleted",
          recordVersion: 3,
          occurredAt: value.occurredAt,
        };
      },
    }),
    () => "71000000-0000-4000-8000-000000000021",
    () => Date.parse("2026-08-23T00:00:00.000Z"),
  );

  const output = await service.decideDeletion({
    actor: actor("founder"),
    command: {
      entityType: "student",
      entityId: uppercaseId,
      decision: "approve",
      expectedRecordVersion: 2,
      correlationRequestId: "uppercase-id",
      idempotencyKey: "uppercase-idempotency",
    },
  });

  assert.equal(output.entityId, canonicalId);
  assert.equal(captured?.command.entityId, canonicalId);
  assert.equal(captured?.effects.audit.resourceId, canonicalId);
  assert.equal(captured?.effects.outbox.aggregateId, canonicalId);
  assert.equal(
    captured?.requestHash,
    hashRequestPayload({
      entity_type: "student",
      entity_id: canonicalId,
      decision: "approve",
      expected_record_version: 2,
    }),
  );

  let requestCaptured:
    | Parameters<DeletionReviewRepository["requestDeletion"]>[0]
    | undefined;
  const requestService = new DeletionReviewService(
    repository([], {
      async requestDeletion(value) {
        requestCaptured = value;
        return receipt();
      },
    }),
    () => "71000000-0000-4000-8000-000000000022",
    () => Date.parse("2026-08-23T00:00:00.000Z"),
  );
  await requestService.requestDeletion({
    actor: actor("founder"),
    command: { ...command(), entityId: uppercaseId },
  });
  assert.equal(requestCaptured?.entityId, canonicalId);
  assert.equal(
    requestCaptured?.requestHash,
    hashRequestPayload({
      entity_type: "student",
      entity_id: canonicalId,
      expected_record_version: 1,
      reason_code: "record.lifecycle.pending_delete_requested",
    }),
  );
});

test("Founder union (Founder+Admin/Advisor) can reject; Advisor alone cannot", async () => {
  const union = (
    roles: readonly ("founder" | "admin" | "advisor")[],
  ): RequestAccessActor => ({
    userId: IDS.actor,
    organizationId: IDS.organization,
    roles,
    workspaceCapabilities: [
      ...new Set(roles.flatMap((role) => workspaceCapabilitiesForRole(role))),
    ],
  });
  for (const roles of [
    ["founder", "admin"],
    ["founder", "advisor"],
  ] as const) {
    let captured:
      | Parameters<DeletionReviewRepository["decideDeletion"]>[0]
      | undefined;
    const service = new DeletionReviewService(
      repository([], {
        async decideDeletion(value) {
          captured = value;
          return {
            entityType: "guardian",
            entityId: IDS.target,
            status: "active",
            recordVersion: 2,
            occurredAt: value.occurredAt,
          };
        },
      }),
    );
    const output = await service.decideDeletion({
      actor: union(roles),
      command: {
        entityType: "guardian",
        entityId: IDS.target,
        decision: "reject",
        expectedRecordVersion: 1,
        correlationRequestId: "reject",
        idempotencyKey: "reject-key",
      },
    });
    assert.equal(output.status, "active");
    assert.equal(captured?.actorRole, "founder");
    assert.equal(
      captured?.requestHash,
      hashRequestPayload({
        entity_type: "guardian",
        entity_id: IDS.target,
        decision: "reject",
        expected_record_version: 1,
      }),
    );
    assert.equal(
      captured?.effects.audit.eventType,
      "crm.soft_deletion_rejected",
    );
    assert.equal(captured?.effects.audit.action, "reject_soft_deletion");
    assert.equal(captured?.effects.audit.resourceType, "Guardian");
    assert.equal(captured?.effects.outbox.aggregateType, "Guardian");
    assert.equal(
      captured?.effects.audit.metadata.reason_code,
      "record.lifecycle.soft_deletion_rejected",
    );
    assert.equal(captured?.effects.audit.metadata.status, "active");
    assert.equal(
      captured?.effects.outbox.payload.reason_code,
      "record.lifecycle.soft_deletion_rejected",
    );
    assert.equal(captured?.effects.outbox.payload.status, "active");
  }
  await denied(() =>
    new DeletionReviewService(repository([])).decideDeletion({
      actor: actor("advisor"),
      command: {
        entityType: "student",
        entityId: IDS.target,
        decision: "approve",
        expectedRecordVersion: 1,
        correlationRequestId: "r",
        idempotencyKey: "k",
      },
    }),
  );
});
