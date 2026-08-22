import assert from "node:assert/strict";
import test from "node:test";

import { PostgresqlGuardianRelationshipRepository } from
  "../../../modules/crm/infrastructure/postgresql-guardian-relationship-repository.ts";
import type {
  TenantDatabaseContext,
  TenantTransaction,
  TenantTransactionRunner,
} from "../../../modules/shared/server.ts";

const CONTEXT = Object.freeze({
  organizationId: "51000000-0000-4000-8000-000000000001",
  actorUserId: "51000000-0000-4000-8000-000000000101",
  studentId: "51000000-0000-4000-8000-000000000601",
});

test("reports only an allowlisted PostgreSQL concurrency code", async () => {
  const reported: unknown[] = [];
  const cause = Object.assign(new Error("raw-secret database message"), {
    code: "57014",
    severity: "ERROR",
    detail: "raw-secret detail",
    query: "SELECT raw-secret",
    stack: "raw-secret stack",
  });
  const repository = new PostgresqlGuardianRelationshipRepository(
    failingRunner(cause),
    (evidence) => reported.push(evidence),
  );

  await assert.rejects(repository.listCurrent(CONTEXT), unavailable());
  assert.deepEqual(reported, [{ postgresCode: "57014" }]);
  assert.doesNotMatch(JSON.stringify(reported), /raw-secret|message|detail|query|stack/);
});

test("does not classify Node error codes or arbitrary objects as PostgreSQL concurrency failures", async () => {
  for (const cause of [Object.assign(new Error("missing"), { code: "ENOENT" }), {
    code: "40P01", severity: "ERROR",
  }]) {
    const reported: unknown[] = [];
    const repository = new PostgresqlGuardianRelationshipRepository(
      failingRunner(cause),
      (evidence) => reported.push(evidence),
    );
    await assert.rejects(repository.listCurrent(CONTEXT), unavailable());
    assert.deepEqual(reported, []);
  }
});

function failingRunner(cause: unknown): TenantTransactionRunner {
  return Object.freeze({
    async run<Result>(
      _context: TenantDatabaseContext,
      operation: (transaction: TenantTransaction) => Promise<Result>,
    ): Promise<Result> {
      return operation(Object.freeze({
        async query(): Promise<never> { throw cause; },
      }));
    },
  });
}

function unavailable() {
  return (error: unknown) => error instanceof Error &&
    error.name === "GuardianRelationshipError" &&
    (error as Error & { readonly code?: unknown }).code === "GUARDIAN_RELATIONSHIP_UNAVAILABLE";
}
