import assert from "node:assert/strict";
import test from "node:test";

import type { MutationEffectBundle } from "../../../modules/audit/public.ts";
import {
  ProfileMaintenanceError,
  type ProfileMaintenanceRepository,
} from "../../../modules/crm/application/profile-maintenance-service.ts";
import { PostgresqlProfileMaintenanceRepository } from "../../../modules/crm/infrastructure/postgresql-profile-maintenance-repository.ts";
import type { TenantDatabaseContext, TenantTransaction, TenantTransactionRunner } from "../../../modules/shared/server.ts";
import { hashRequestPayload } from "../../../modules/shared/public.ts";

const IDS = Object.freeze({
  organization: "51000000-0000-4000-8000-000000000001",
  actor: "51000000-0000-4000-8000-000000000101",
  student: "51000000-0000-4000-8000-000000000601",
  guardian: "51000000-0000-4000-8000-000000000701",
});
const HASH = "a".repeat(64);
const UPDATED_AT = "2026-08-23T08:00:00.000Z";

test("updates a Student with receipt, lock, audit and outbox in one tenant transaction", async () => {
  const sql: string[] = [];
  let context: unknown;
  let completedReceiptValues: readonly unknown[] | undefined;
  const repository = new PostgresqlProfileMaintenanceRepository(runner(async (input, query) => {
    context = input;
    return query(async (text, values) => {
      sql.push(text);
      if (text.includes("INSERT INTO shared_idempotency_records")) return result([], 1);
      if (text.includes("SELECT request_hash")) return result([{
        request_hash: HASH, state: "in_progress", result_reference: null,
      }]);
      if (text === "SELECT status FROM crm_students WHERE id = $1") return result([{ status: "active" }]);
      if (text.includes("SELECT status, record_version FROM crm_students")) {
        return result([{ status: "active", record_version: 1 }]);
      }
      if (text.includes("UPDATE crm_students")) {
        return result([{ id: IDS.student, record_version: 2, updated_at: UPDATED_AT }], 1);
      }
      if (text.includes("UPDATE shared_idempotency_records")) completedReceiptValues = values;
      return result([], 1);
    });
  }));
  const acknowledgement = await repository.updateStudent(studentInput());
  assert.deepEqual(context, { organizationId: IDS.organization, actorUserId: IDS.actor });
  assert.deepEqual(acknowledgement, { id: IDS.student, recordVersion: 2, updatedAt: UPDATED_AT });
  assert.equal(sql.length, 8);
  assert.match(sql[0]!, /INSERT INTO shared_idempotency_records/);
  assert.match(sql[3]!, /FOR UPDATE/);
  assert.match(sql[4]!, /record_version = record_version \+ 1/);
  assert.match(sql[5]!, /INSERT INTO audit_events/);
  assert.match(sql[6]!, /INSERT INTO audit_outbox/);
  assert.match(sql[7]!, /UPDATE shared_idempotency_records/);
  assert.match(sql[7]!, /response_hash = \$6/);
  assert.match(sql[7]!, /request_hash = \$7/);
  assert.equal(completedReceiptValues?.[5], acknowledgementHash(IDS.student, 2, UPDATED_AT));
  assert.equal(completedReceiptValues?.[6], HASH);
  assert.notEqual(completedReceiptValues?.[5], completedReceiptValues?.[6]);
});

test("returns the first exact non-PII acknowledgement after a later profile update", async () => {
  const sql: string[] = [];
  const reference = `${IDS.student}:2:${UPDATED_AT}`;
  const repository = new PostgresqlProfileMaintenanceRepository(runner(async (_input, query) => {
    return query(async (text) => {
      sql.push(text);
      if (text.includes("INSERT INTO shared_idempotency_records")) return result([], 0);
      if (text.includes("SELECT request_hash")) return result([{
        request_hash: HASH, state: "completed", result_reference: reference,
        response_hash: acknowledgementHash(IDS.student, 2, UPDATED_AT),
      }]);
      if (text === "SELECT status FROM crm_students WHERE id = $1") return result([{ status: "active" }]);
      return result([]);
    });
  }));
  const acknowledgement = await repository.updateStudent(studentInput());
  assert.deepEqual(acknowledgement, { id: IDS.student, recordVersion: 2, updatedAt: UPDATED_AT });
  assert.equal(sql.some((text) => text.includes("UPDATE crm_students")), false);
  assert.equal(sql.some((text) => text.includes("INSERT INTO audit_events")), false);
});

test("Advisor assignment is rechecked and denied updates create no effects", async () => {
  const sql: string[] = [];
  const repository = new PostgresqlProfileMaintenanceRepository(runner(async (_input, query) =>
    query(async (text) => {
      sql.push(text);
      if (text.includes("INSERT INTO shared_idempotency_records")) return result([], 1);
      if (text.includes("SELECT request_hash")) return result([{
        request_hash: HASH, state: "in_progress", result_reference: null,
      }]);
      if (text === "SELECT status FROM crm_guardians WHERE id = $1") return result([{ status: "active" }]);
      if (text.includes("FROM crm_student_guardian_relationships AS relationship")) return result([]);
      return result([]);
    })));
  await assert.rejects(repository.updateGuardian({ ...guardianInput(), actorRole: "advisor" }),
    code("PROFILE_MAINTENANCE_FORBIDDEN"));
  assert.match(sql.at(-1) ?? "", /cases_service_cases/);
  assert.equal(sql.some((text) => text.includes("UPDATE crm_guardians")), false);
  assert.equal(sql.some((text) => text.includes("INSERT INTO audit_events")), false);
});

test("assigned Advisor reaches the inactive guard for a pending Guardian without widening active scope", async () => {
  for (const [assigned, expectedCode] of [[true, "PROFILE_MAINTENANCE_INACTIVE"],
    [false, "PROFILE_MAINTENANCE_FORBIDDEN"]] as const) {
    const sql: string[] = [];
    let accessValues: readonly unknown[] | undefined;
    const repository = new PostgresqlProfileMaintenanceRepository(runner(async (_input, query) =>
      query(async (text, values) => {
        sql.push(text);
        if (text.includes("INSERT INTO shared_idempotency_records")) return result([], 1);
        if (text.includes("SELECT request_hash")) return result([{
          request_hash: HASH, state: "in_progress", result_reference: null,
        }]);
        if (text === "SELECT status FROM crm_guardians WHERE id = $1") {
          return result([{ status: "pending_delete" }]);
        }
        if (text.includes("FROM crm_student_guardian_relationships AS relationship")) {
          accessValues = values;
          return result(assigned ? [{ id: "51000000-0000-4000-8000-000000000801" }] : []);
        }
        return result([]);
      })));
    await assert.rejects(repository.updateGuardian({ ...guardianInput(), actorRole: "advisor" }),
      code(expectedCode));
    const accessSql = sql.find((text) => text.includes("FROM crm_student_guardian_relationships")) ?? "";
    assert.match(accessSql, /\$3 = 'pending_delete'/);
    assert.match(accessSql, /student\.status = 'active'/);
    assert.match(accessSql, /student\.status = 'pending_delete'/);
    assert.equal(accessValues?.[2], "pending_delete");
    assert.equal(sql.some((text) => text.includes("UPDATE crm_guardians")), false);
    assert.equal(sql.some((text) => text.includes("INSERT INTO audit_events")), false);
  }
});

test("changed payload conflicts and stale versions remain distinct", async () => {
  const conflict = new PostgresqlProfileMaintenanceRepository(runner(async (_input, query) =>
    query(async (text) => text.includes("INSERT INTO shared_idempotency_records")
      ? result([], 0)
      : result([{ request_hash: "b".repeat(64), state: "completed",
        result_reference: `${IDS.student}:2:${UPDATED_AT}`,
        response_hash: acknowledgementHash(IDS.student, 2, UPDATED_AT) }]))));
  await assert.rejects(conflict.updateStudent(studentInput()),
    code("PROFILE_MAINTENANCE_IDEMPOTENCY_CONFLICT"));

  const staleRepository = new PostgresqlProfileMaintenanceRepository(runner(async (_input, query) =>
    query(async (text) => {
      if (text.includes("INSERT INTO shared_idempotency_records")) return result([], 1);
      if (text.includes("SELECT request_hash")) return result([{
        request_hash: HASH, state: "in_progress", result_reference: null,
      }]);
      if (text === "SELECT status FROM crm_students WHERE id = $1") return result([{ status: "active" }]);
      if (text.includes("SELECT status, record_version FROM crm_students")) {
        return result([{ status: "active", record_version: 7 }]);
      }
      return result([]);
    })));
  await assert.rejects(staleRepository.updateStudent(studentInput()),
    code("PROFILE_MAINTENANCE_STALE_VERSION"));
});

test("fails closed when a completed receipt response hash does not match its acknowledgement", async () => {
  const repository = new PostgresqlProfileMaintenanceRepository(runner(async (_input, query) => {
    return query(async (text) => {
      if (text.includes("INSERT INTO shared_idempotency_records")) return result([], 0);
      if (text.includes("SELECT request_hash")) return result([{
        request_hash: HASH,
        state: "completed",
        result_reference: `${IDS.student}:2:${UPDATED_AT}`,
        response_hash: "b".repeat(64),
      }]);
      if (text === "SELECT status FROM crm_students WHERE id = $1") return result([{ status: "active" }]);
      return result([]);
    });
  }));
  await assert.rejects(repository.updateStudent(studentInput()),
    code("PROFILE_MAINTENANCE_UNAVAILABLE"));
});

function studentInput(): Parameters<ProfileMaintenanceRepository["updateStudent"]>[0] {
  return { organizationId: IDS.organization, actorUserId: IDS.actor, actorRole: "founder",
    studentId: IDS.student, displayName: "Student", dateOfBirth: "2012-06-01",
    contactEmail: "student@example.invalid", contactPhone: null, expectedRecordVersion: 1,
    idempotencyKey: "student-profile:1", requestHash: HASH, effects: effects(IDS.student) };
}

function guardianInput(): Parameters<ProfileMaintenanceRepository["updateGuardian"]>[0] {
  return { organizationId: IDS.organization, actorUserId: IDS.actor, actorRole: "founder",
    guardianId: IDS.guardian, displayName: "Guardian", email: "guardian@example.invalid",
    phone: null, expectedRecordVersion: 1, idempotencyKey: "guardian-profile:1",
    requestHash: HASH, effects: effects(IDS.guardian) };
}

function effects(resourceId: string): MutationEffectBundle {
  return { audit: { id: "51000000-0000-4000-8000-000000000801", organizationId: IDS.organization,
    actorUserId: IDS.actor, actorKind: "user", eventType: "crm.profile_updated", eventVersion: 1,
    action: "update", resourceType: "Student", resourceId, outcome: "succeeded",
    requestId: "profile-request", occurredAt: UPDATED_AT, beforeHashSha256: null,
    afterHashSha256: null, metadata: {} }, outbox: {
    id: "51000000-0000-4000-8000-000000000802",
    auditEventId: "51000000-0000-4000-8000-000000000801", organizationId: IDS.organization,
    aggregateType: "Student", aggregateId: resourceId, eventType: "crm.profile_updated",
    eventVersion: 1, idempotencyKey: "profile-outbox", requestId: "profile-request", payload: {},
    status: "pending", attemptCount: 0, availableAt: UPDATED_AT, createdAt: UPDATED_AT } };
}

function runner(run: (context: TenantDatabaseContext,
  query: (execute: (text: string, values?: readonly unknown[]) => Promise<unknown>) => Promise<unknown>,
) => Promise<unknown>): TenantTransactionRunner {
  return Object.freeze({ async run<Result>(context: TenantDatabaseContext,
    operation: (transaction: TenantTransaction) => Promise<Result>): Promise<Result> {
    return await run(context, async (execute) => operation({
      query: ({ text, values }) => execute(text, values) as never,
    })) as Result;
  } });
}

function result(rows: readonly Record<string, unknown>[], rowCount = rows.length) {
  return Object.freeze({ rows, rowCount });
}

function acknowledgementHash(id: string, recordVersion: number, updatedAt: string): string {
  return hashRequestPayload({ id, record_version: recordVersion, updated_at: updatedAt });
}

function code(expected: ProfileMaintenanceError["code"]) {
  return (error: unknown) => error instanceof ProfileMaintenanceError && error.code === expected;
}
