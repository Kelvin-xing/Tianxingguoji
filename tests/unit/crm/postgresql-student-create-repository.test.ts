import assert from "node:assert/strict";
import test from "node:test";

import type { MutationEffectBundle } from "../../../modules/audit/public.ts";
import {
  StudentCreateRepositoryError,
  type StudentCreateRepository,
} from "../../../modules/crm/application/student-create-service.ts";
import { PostgresqlStudentCreateRepository } from "../../../modules/crm/infrastructure/postgresql-student-create-repository.ts";
import type {
  TenantDatabaseContext,
  TenantTransaction,
  TenantTransactionRunner,
} from "../../../modules/shared/server.ts";

const IDS = Object.freeze({
  organization: "62000000-0000-4000-8000-000000000001",
  actor: "62000000-0000-4000-8000-000000000002",
  student: "62000000-0000-4000-8000-000000000003",
  guardian: "62000000-0000-4000-8000-000000000004",
  relationship: "62000000-0000-4000-8000-000000000005",
});

test("writes idempotency, aggregate, audit and outbox in one tenant transaction", async () => {
  const sql: string[] = [];
  let context: unknown;
  const repository = new PostgresqlStudentCreateRepository(runner(async (input, query) => {
    context = input;
    return query(async (text) => {
      sql.push(text);
      if (text.includes("INSERT INTO shared_idempotency_records")) return result([], 1);
      if (text.includes("SELECT request_hash")) return result([{
        request_hash: "a".repeat(64), state: "in_progress", result_reference: null,
      }]);
      return result([], 1);
    });
  }));

  const created = await repository.createStudent(input());
  assert.deepEqual(context, { organizationId: IDS.organization, actorUserId: IDS.actor });
  assert.deepEqual(created, {
    student: { id: IDS.student, displayName: "Synthetic Student" },
    primaryGuardian: { id: IDS.guardian, displayName: "Synthetic Guardian" },
    relationship: { id: IDS.relationship, relationshipType: "father" },
  });
  assert.equal(sql.length, 8);
  assert.match(sql[0]!, /INSERT INTO shared_idempotency_records/);
  assert.match(sql[1]!, /FOR UPDATE/);
  assert.match(sql[2]!, /INSERT INTO crm_students/);
  assert.match(sql[3]!, /INSERT INTO crm_guardians/);
  assert.match(sql[4]!, /INSERT INTO crm_student_guardian_relationships/);
  assert.match(sql[4]!, /true,false,false,false,transaction_timestamp\(\)/);
  assert.match(sql[5]!, /INSERT INTO audit_events/);
  assert.match(sql[6]!, /INSERT INTO audit_outbox/);
  assert.match(sql[7]!, /UPDATE shared_idempotency_records/);
});

test("exact replay reads the original aggregate without duplicate inserts", async () => {
  const sql: string[] = [];
  const repository = new PostgresqlStudentCreateRepository(runner(async (_input, query) => {
    return query(async (text) => {
      sql.push(text);
      if (text.includes("INSERT INTO shared_idempotency_records")) return result([], 0);
      if (text.includes("SELECT request_hash")) return result([{
        request_hash: "a".repeat(64), state: "completed", result_reference: IDS.student,
      }]);
      if (text.includes("student_display_name")) return result([{
        student_id: IDS.student,
        student_display_name: "Synthetic Student",
        guardian_id: IDS.guardian,
        guardian_display_name: "Synthetic Guardian",
        relationship_id: IDS.relationship,
        relationship_type: "father",
      }]);
      return result([]);
    });
  }));

  const replay = await repository.createStudent(input());
  assert.equal(replay.student.id, IDS.student);
  assert.equal(sql.length, 3);
  assert.equal(sql.some((text) => text.includes("INSERT INTO crm_students")), false);
});

test("same key with changed hash conflicts and unexpected SQL failures are unavailable", async () => {
  const conflict = new PostgresqlStudentCreateRepository(runner(async (_input, query) => {
    return query(async (text) => text.includes("INSERT INTO shared_idempotency_records")
      ? result([], 0)
      : result([{ request_hash: "b".repeat(64), state: "completed", result_reference: IDS.student }]));
  }));
  await assert.rejects(conflict.createStudent(input()), repositoryCode(
    "STUDENT_CREATE_IDEMPOTENCY_CONFLICT",
  ));

  const unavailable = new PostgresqlStudentCreateRepository(runner(async (_input, query) => {
    return query(async (text) => {
      if (text.includes("INSERT INTO shared_idempotency_records")) return result([], 1);
      if (text.includes("SELECT request_hash")) return result([{
        request_hash: "a".repeat(64), state: "in_progress", result_reference: null,
      }]);
      throw Object.freeze({ code: "XX001", detail: "private database detail" });
    });
  }));
  await assert.rejects(unavailable.createStudent(input()), repositoryCode(
    "STUDENT_CREATE_UNAVAILABLE",
  ));
});

function input(): Parameters<StudentCreateRepository["createStudent"]>[0] {
  return {
    organizationId: IDS.organization,
    actorUserId: IDS.actor,
    studentId: IDS.student,
    guardianId: IDS.guardian,
    relationshipId: IDS.relationship,
    student: {
      displayName: "Synthetic Student",
      dateOfBirth: "2013-06-18",
      contactEmail: null,
      contactPhone: null,
    },
    primaryGuardian: {
      displayName: "Synthetic Guardian",
      email: "guardian@example.invalid",
      phone: null,
      relationshipType: "father",
      isLegalGuardian: true,
    },
    idempotencyKey: "crm-repository-attempt-1",
    requestHash: "a".repeat(64),
    createdAtMs: Date.parse("2026-08-22T08:00:00.000Z"),
    effects: effects(),
  };
}

function effects(): MutationEffectBundle {
  return {
    audit: {
      id: "62000000-0000-4000-8000-000000000006",
      organizationId: IDS.organization,
      actorUserId: IDS.actor,
      actorKind: "user",
      eventType: "crm.student_primary_guardian_created",
      eventVersion: 1,
      action: "create",
      resourceType: "Student",
      resourceId: IDS.student,
      outcome: "succeeded",
      requestId: "crm-repository-request-1",
      occurredAt: "2026-08-22T08:00:00.000Z",
      beforeHashSha256: null,
      afterHashSha256: null,
      metadata: {},
    },
    outbox: {
      id: "62000000-0000-4000-8000-000000000007",
      auditEventId: "62000000-0000-4000-8000-000000000006",
      organizationId: IDS.organization,
      aggregateType: "Student",
      aggregateId: IDS.student,
      eventType: "crm.student_primary_guardian_created",
      eventVersion: 1,
      idempotencyKey: "crm-repository-outbox-1",
      requestId: "crm-repository-request-1",
      payload: {},
      status: "pending",
      attemptCount: 0,
      availableAt: "2026-08-22T08:00:00.000Z",
      createdAt: "2026-08-22T08:00:00.000Z",
    },
  };
}

function runner(
  run: (
    context: Readonly<{ organizationId: string; actorUserId: string }>,
    query: (operation: (
      text: string,
      values?: readonly unknown[],
    ) => Promise<unknown>) => Promise<unknown>,
  ) => Promise<unknown>,
): TenantTransactionRunner {
  return Object.freeze({
    async run<Result>(
      context: TenantDatabaseContext,
      operation: (transaction: TenantTransaction) => Promise<Result>,
    ): Promise<Result> {
      return await run(context, async (execute) => operation({
        query: ({ text, values }) => execute(text, values) as never,
      })) as Result;
    },
  });
}

function result(rows: readonly Record<string, unknown>[], rowCount = rows.length) {
  return Object.freeze({ rows, rowCount });
}

function repositoryCode(code: StudentCreateRepositoryError["code"]) {
  return (error: unknown) => error instanceof StudentCreateRepositoryError && error.code === code;
}
