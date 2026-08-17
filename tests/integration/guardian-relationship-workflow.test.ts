import assert from "node:assert/strict";
import test from "node:test";

import {
  GuardianRelationshipError,
  GuardianRelationshipService,
  type GuardianRelationshipResult,
} from "../../modules/crm/application/guardian-relationship-service.ts";

const ADVISOR = Object.freeze({
  userId: "11111111-1111-4111-8111-111111111111",
  organizationId: "22222222-2222-4222-8222-222222222222",
  role: "advisor" as const,
  sessionId: "33333333-3333-4333-8333-333333333333",
  capturedSessionVersion: 1,
  reauthenticatedAtMs: 1_754_265_600_000,
});
const SIBLING_A = "44444444-4444-4444-8444-444444444444";
const SIBLING_B = "55555555-5555-4555-8555-555555555555";
const SHARED_GUARDIAN = "66666666-6666-4666-8666-666666666666";
const SUCCESSOR_GUARDIAN = "77777777-7777-4777-8777-777777777777";

class FixedClock {
  nowMs(): number {
    return 1_754_265_600_000;
  }
}

class InMemoryGuardianRelationshipRepository {
  private readonly activeStudentIds = new Set<string>();
  private readonly activeGuardianIds = new Set<string>();
  private readonly relationships: GuardianRelationshipResult[] = [];
  private failNextHandoffCommit = false;

  activateStudent(studentId: string): void {
    this.activeStudentIds.add(studentId);
  }

  activateGuardian(guardianId: string): void {
    this.activeGuardianIds.add(guardianId);
  }

  failOnceBeforeHandoffCommit(): void {
    this.failNextHandoffCommit = true;
  }

  async createRelationship(input: {
    readonly organizationId: string;
    readonly studentId: string;
    readonly guardianId: string;
    readonly relationshipId: string;
    readonly relationshipType: string;
    readonly isLegalGuardian: boolean;
    readonly isPrimaryContact: boolean;
    readonly isEmergencyContact: boolean;
    readonly isBillingContact: boolean;
    readonly notificationConsent: boolean;
    readonly createdAtMs: number;
  }): Promise<GuardianRelationshipResult> {
    if (!this.activeStudentIds.has(input.studentId)) {
      throw new GuardianRelationshipError("GUARDIAN_RELATIONSHIP_STUDENT_NOT_FOUND");
    }
    if (!this.activeGuardianIds.has(input.guardianId)) {
      throw new GuardianRelationshipError("GUARDIAN_RELATIONSHIP_GUARDIAN_NOT_FOUND");
    }
    if (
      this.relationships.some(
        (relationship) =>
          relationship.studentId === input.studentId &&
          relationship.guardianId === input.guardianId &&
          relationship.endsAtMs === null,
      )
    ) {
      throw new GuardianRelationshipError("GUARDIAN_RELATIONSHIP_CURRENT_PAIR_EXISTS");
    }
    if (
      input.isPrimaryContact &&
      this.relationships.some(
        (relationship) => relationship.studentId === input.studentId && relationship.isPrimaryContact && relationship.endsAtMs === null,
      )
    ) {
      throw new GuardianRelationshipError("GUARDIAN_RELATIONSHIP_PRIMARY_CONFLICT");
    }

    const result: GuardianRelationshipResult = Object.freeze({
      relationshipId: input.relationshipId,
      studentId: input.studentId,
      guardianId: input.guardianId,
      relationshipType: input.relationshipType,
      isLegalGuardian: input.isLegalGuardian,
      isPrimaryContact: input.isPrimaryContact,
      isEmergencyContact: input.isEmergencyContact,
      isBillingContact: input.isBillingContact,
      notificationConsent: input.notificationConsent,
      startsAtMs: input.createdAtMs,
      endsAtMs: null,
      recordVersion: 1,
    });
    this.relationships.push(result);
    return result;
  }

  async handoffPrimaryContact(input: {
    readonly studentId: string;
    readonly successorGuardianId: string;
    readonly relationshipId: string;
    readonly expectedPrimaryRecordVersion: number;
    readonly reason: string;
    readonly createdAtMs: number;
  }): Promise<GuardianRelationshipResult> {
    const currentPrimary = this.relationships.find(
      (relationship) =>
        relationship.studentId === input.studentId &&
        relationship.isPrimaryContact &&
        relationship.endsAtMs === null,
    );
    const successor = this.relationships.find(
      (relationship) =>
        relationship.studentId === input.studentId &&
        relationship.guardianId === input.successorGuardianId &&
        relationship.endsAtMs === null,
    );
    if (!currentPrimary || !successor || currentPrimary.guardianId === successor.guardianId) {
      throw new GuardianRelationshipError("GUARDIAN_RELATIONSHIP_PRIMARY_REQUIRED");
    }
    if (currentPrimary.recordVersion !== input.expectedPrimaryRecordVersion) {
      throw new GuardianRelationshipError("GUARDIAN_RELATIONSHIP_STALE_VERSION");
    }

    const closedAtMs = input.createdAtMs;
    const nextRelationships = this.relationships.map((relationship) =>
      relationship === currentPrimary || relationship === successor
        ? Object.freeze({
            ...relationship,
            endsAtMs: closedAtMs,
            recordVersion: relationship.recordVersion + 1,
          })
        : relationship,
    );
    const replacement: GuardianRelationshipResult = Object.freeze({
      relationshipId: input.relationshipId,
      studentId: successor.studentId,
      guardianId: successor.guardianId,
      relationshipType: successor.relationshipType,
      isLegalGuardian: successor.isLegalGuardian,
      isPrimaryContact: true,
      isEmergencyContact: successor.isEmergencyContact,
      isBillingContact: successor.isBillingContact,
      notificationConsent: successor.notificationConsent,
      startsAtMs: closedAtMs,
      endsAtMs: null,
      recordVersion: 1,
    });
    if (this.failNextHandoffCommit) {
      this.failNextHandoffCommit = false;
      throw new Error("synthetic handoff transaction failure");
    }
    this.relationships.splice(0, this.relationships.length, ...nextRelationships, replacement);
    return replacement;
  }

  historyFor(studentId: string): readonly GuardianRelationshipResult[] {
    return this.relationships.filter((relationship) => relationship.studentId === studentId);
  }

  snapshot(): Readonly<{ relationships: number; currentPrimaries: number; sharedGuardianRelations: number }> {
    return Object.freeze({
      relationships: this.relationships.length,
      currentPrimaries: this.relationships.filter(
        (relationship) => relationship.isPrimaryContact && relationship.endsAtMs === null,
      ).length,
      sharedGuardianRelations: this.relationships.filter(
        (relationship) => relationship.guardianId === SHARED_GUARDIAN && relationship.endsAtMs === null,
      ).length,
    });
  }
}

test("an existing Guardian can be the current primary contact for two siblings", async () => {
  const repository = new InMemoryGuardianRelationshipRepository();
  repository.activateStudent(SIBLING_A);
  repository.activateStudent(SIBLING_B);
  repository.activateGuardian(SHARED_GUARDIAN);
  const service = new GuardianRelationshipService({
    repository,
    clock: new FixedClock(),
    createId: sequenceIds(100),
  });

  const first = await service.attachGuardian({
    actor: ADVISOR,
    command: relationshipCommand({ studentId: SIBLING_A }),
  });
  const second = await service.attachGuardian({
    actor: ADVISOR,
    command: relationshipCommand({
      studentId: SIBLING_B,
      requestId: "guardian.attach.sibling-b",
      idempotencyKey: "guardian-attach-sibling-b",
    }),
  });

  assert.equal(first.guardianId, SHARED_GUARDIAN);
  assert.equal(second.guardianId, SHARED_GUARDIAN);
  assert.equal(first.studentId, SIBLING_A);
  assert.equal(second.studentId, SIBLING_B);
  assert.equal(first.isPrimaryContact, true);
  assert.equal(second.isPrimaryContact, true);
  assert.deepEqual(repository.snapshot(), {
    relationships: 2,
    currentPrimaries: 2,
    sharedGuardianRelations: 2,
  });
});

test("an Advisor atomically hands the primary role to an existing secondary and retains history", async () => {
  const repository = new InMemoryGuardianRelationshipRepository();
  repository.activateStudent(SIBLING_A);
  repository.activateGuardian(SHARED_GUARDIAN);
  repository.activateGuardian(SUCCESSOR_GUARDIAN);
  const service = new GuardianRelationshipService({
    repository,
    clock: new FixedClock(),
    createId: sequenceIds(200),
  });
  const previousPrimary = await service.attachGuardian({
    actor: ADVISOR,
    command: relationshipCommand(),
  });
  await service.attachGuardian({
    actor: ADVISOR,
    command: relationshipCommand({
      guardianId: SUCCESSOR_GUARDIAN,
      isPrimaryContact: false,
      requestId: "guardian.attach.successor",
      idempotencyKey: "guardian-attach-successor",
    }),
  });

  const replacement = await service.handoffPrimaryContact({
    actor: ADVISOR,
    command: {
      studentId: SIBLING_A,
      successorGuardianId: SUCCESSOR_GUARDIAN,
      expectedPrimaryRecordVersion: previousPrimary.recordVersion,
      reason: "guardian.primary.handoff",
      requestId: "guardian.primary.handoff",
      idempotencyKey: "guardian-primary-handoff",
    },
  });

  assert.equal(replacement.guardianId, SUCCESSOR_GUARDIAN);
  assert.equal(replacement.isPrimaryContact, true);
  assert.equal(replacement.endsAtMs, null);
  assert.deepEqual(
    repository.historyFor(SIBLING_A).map((relationship) => ({
      guardianId: relationship.guardianId,
      isPrimaryContact: relationship.isPrimaryContact,
      endsAtMs: relationship.endsAtMs,
      recordVersion: relationship.recordVersion,
    })),
    [
      {
        guardianId: SHARED_GUARDIAN,
        isPrimaryContact: true,
        endsAtMs: 1_754_265_600_000,
        recordVersion: 2,
      },
      {
        guardianId: SUCCESSOR_GUARDIAN,
        isPrimaryContact: false,
        endsAtMs: 1_754_265_600_000,
        recordVersion: 2,
      },
      {
        guardianId: SUCCESSOR_GUARDIAN,
        isPrimaryContact: true,
        endsAtMs: null,
        recordVersion: 1,
      },
    ],
  );
});

test("a non-Advisor cannot attach a Guardian relationship", async () => {
  const repository = new InMemoryGuardianRelationshipRepository();
  repository.activateStudent(SIBLING_A);
  repository.activateGuardian(SHARED_GUARDIAN);
  const service = new GuardianRelationshipService({ repository, clock: new FixedClock(), createId: sequenceIds(300) });

  await assert.rejects(
    service.attachGuardian({ actor: { ...ADVISOR, role: "founder" }, command: relationshipCommand() }),
    hasGuardianRelationshipCode("GUARDIAN_RELATIONSHIP_ADVISOR_REQUIRED"),
  );
  assert.deepEqual(repository.snapshot(), {
    relationships: 0,
    currentPrimaries: 0,
    sharedGuardianRelations: 0,
  });
});

test("current pair conflicts are rejected without a second relationship history row", async () => {
  const repository = new InMemoryGuardianRelationshipRepository();
  repository.activateStudent(SIBLING_A);
  repository.activateGuardian(SHARED_GUARDIAN);
  const service = new GuardianRelationshipService({ repository, clock: new FixedClock(), createId: sequenceIds(400) });
  await service.attachGuardian({ actor: ADVISOR, command: relationshipCommand() });

  await assert.rejects(
    service.attachGuardian({
      actor: ADVISOR,
      command: relationshipCommand({
        requestId: "guardian.attach.duplicate",
        idempotencyKey: "guardian-attach-duplicate",
      }),
    }),
    hasGuardianRelationshipCode("GUARDIAN_RELATIONSHIP_CURRENT_PAIR_EXISTS"),
  );
  assert.equal(repository.historyFor(SIBLING_A).length, 1);
});

test("a stale primary version rejects the handoff without changing relationship history", async () => {
  const { repository, service, previousPrimary } = await createHandoffScenario(500);
  const before = repository.historyFor(SIBLING_A);

  await assert.rejects(
    service.handoffPrimaryContact({
      actor: ADVISOR,
      command: {
        studentId: SIBLING_A,
        successorGuardianId: SUCCESSOR_GUARDIAN,
        expectedPrimaryRecordVersion: previousPrimary.recordVersion + 1,
        reason: "guardian.primary.handoff",
        requestId: "guardian.primary.stale",
        idempotencyKey: "guardian-primary-stale",
      },
    }),
    hasGuardianRelationshipCode("GUARDIAN_RELATIONSHIP_STALE_VERSION"),
  );
  assert.deepEqual(repository.historyFor(SIBLING_A), before);
});

test("a repository failure rolls back the primary handoff without partial history", async () => {
  const { repository, service, previousPrimary } = await createHandoffScenario(600);
  const before = repository.historyFor(SIBLING_A);
  repository.failOnceBeforeHandoffCommit();

  await assert.rejects(
    service.handoffPrimaryContact({
      actor: ADVISOR,
      command: {
        studentId: SIBLING_A,
        successorGuardianId: SUCCESSOR_GUARDIAN,
        expectedPrimaryRecordVersion: previousPrimary.recordVersion,
        reason: "guardian.primary.handoff",
        requestId: "guardian.primary.rollback",
        idempotencyKey: "guardian-primary-rollback",
      },
    }),
    /synthetic handoff transaction failure/,
  );
  assert.deepEqual(repository.historyFor(SIBLING_A), before);
});

async function createHandoffScenario(startingId: number) {
  const repository = new InMemoryGuardianRelationshipRepository();
  repository.activateStudent(SIBLING_A);
  repository.activateGuardian(SHARED_GUARDIAN);
  repository.activateGuardian(SUCCESSOR_GUARDIAN);
  const service = new GuardianRelationshipService({
    repository,
    clock: new FixedClock(),
    createId: sequenceIds(startingId),
  });
  const previousPrimary = await service.attachGuardian({ actor: ADVISOR, command: relationshipCommand() });
  await service.attachGuardian({
    actor: ADVISOR,
    command: relationshipCommand({
      guardianId: SUCCESSOR_GUARDIAN,
      isPrimaryContact: false,
      requestId: "guardian.attach.successor",
      idempotencyKey: "guardian-attach-successor",
    }),
  });
  return { repository, service, previousPrimary };
}

function hasGuardianRelationshipCode(code: string) {
  return (error: unknown) => error instanceof GuardianRelationshipError && error.code === code;
}

function relationshipCommand(overrides: Partial<{
  readonly studentId: string;
  readonly guardianId: string;
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly isPrimaryContact: boolean;
}> = {}) {
  return {
    studentId: SIBLING_A,
    guardianId: SHARED_GUARDIAN,
    relationshipType: "parent",
    isLegalGuardian: true,
    isPrimaryContact: true,
    isEmergencyContact: true,
    isBillingContact: false,
    notificationConsent: true,
    requestId: "guardian.attach.sibling-a",
    idempotencyKey: "guardian-attach-sibling-a",
    ...overrides,
  } as const;
}

function sequenceIds(start: number): () => string {
  let current = start;
  return () => {
    current += 1;
    return `00000000-0000-4000-8000-${String(current).padStart(12, "0")}`;
  };
}
