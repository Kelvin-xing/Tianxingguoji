import assert from "node:assert/strict";
import test from "node:test";

import { DocumentWorkspaceService } from "../../../modules/documents/application/workspace-service.ts";
import { PostgresqlDocumentWorkspaceRepository } from "../../../modules/documents/infrastructure/postgresql-workspace-repository.ts";
import type { IdentitySessionActor } from "../../../modules/identity/public.ts";
import type {
  DatabaseQuery,
  DatabaseQueryResult,
  TenantDatabaseContext,
  TenantTransaction,
  TenantTransactionRunner,
} from "../../../modules/shared/server.ts";

const IDS = [
  "81000000-0000-4000-8000-000000000201",
  "81000000-0000-4000-8000-000000000202",
  "81000000-0000-4000-8000-000000000203",
  "81000000-0000-4000-8000-000000000204",
  "81000000-0000-4000-8000-000000000205",
] as const;

test("DOC-01 repository registers metadata, effects and receipt in one tenant transaction", async () => {
  const statements: string[] = [];
  let receiptValues: readonly unknown[] | undefined;
  const runner: TenantTransactionRunner = Object.freeze({
    async run<Result>(
      _context: TenantDatabaseContext,
      operation: (transaction: TenantTransaction) => Promise<Result>,
    ): Promise<Result> {
      const transaction: TenantTransaction = Object.freeze({
        async query<Row = Record<string, unknown>>(
          query: DatabaseQuery,
        ): Promise<DatabaseQueryResult<Row>> {
          statements.push(query.text);
          if (query.text.includes("INSERT INTO shared_idempotency_records")) {
            return result([{ id: IDS[4] }]) as DatabaseQueryResult<Row>;
          }
          if (query.text.includes("SELECT request_hash,state,result_reference")) {
            return result([]) as DatabaseQueryResult<Row>;
          }
          if (query.text.includes("SELECT binding.role")) {
            return result([{ role: "advisor" }]) as DatabaseQueryResult<Row>;
          }
          if (query.text.includes("SELECT service_case.id")) {
            return result([{ id: IDS[1], stage: "signed", student_status: "active" }]) as DatabaseQueryResult<Row>;
          }
          if (query.text.includes("INSERT INTO documents_documents")) {
            assert.deepEqual(query.values?.slice(0, 5), [
              IDS[2], IDS[0], IDS[1], "Synthetic Evidence", "identity_and_case_evidence",
            ]);
            return result([], 1) as DatabaseQueryResult<Row>;
          }
          if (query.text.includes("INSERT INTO audit_events") ||
              query.text.includes("INSERT INTO audit_outbox")) {
            assert.doesNotMatch(JSON.stringify(query.values), /Synthetic Evidence/);
            return result([], 1) as DatabaseQueryResult<Row>;
          }
          if (query.text.includes("UPDATE shared_idempotency_records")) {
            receiptValues = query.values;
            return result([], 1) as DatabaseQueryResult<Row>;
          }
          throw new Error("Unexpected DOC-01 repository query.");
        },
      });
      return operation(transaction);
    },
  });
  let index = 2;
  const service = new DocumentWorkspaceService(
    new PostgresqlDocumentWorkspaceRepository(runner),
    () => IDS[index++]!,
    () => Date.parse("2026-08-23T00:00:00.000Z"),
  );
  assert.deepEqual(await service.register({
    actor: actor(),
    caseId: IDS[1],
    command: {
      displayName: "Synthetic Evidence",
      classification: "identity_and_case_evidence",
      requestId: "doc-01-repository",
      idempotencyKey: "doc-01-repository",
    },
  }), { id: IDS[2], recordVersion: 1 });

  assert.equal(statements.filter((sql) => sql.includes("INSERT INTO documents_documents")).length, 1);
  assert.equal(statements.filter((sql) => sql.includes("INSERT INTO audit_events")).length, 1);
  assert.equal(statements.filter((sql) => sql.includes("INSERT INTO audit_outbox")).length, 1);
  assert.equal(statements.some((sql) => /INSERT INTO documents_(document_versions|scan_results)/.test(sql)), false);
  assert.equal(receiptValues?.[4], `${IDS[2]}:1`);
  assert.equal(typeof receiptValues?.[5], "string");
  assert.notEqual(receiptValues?.[5], receiptValues?.[6]);
});

test("DOC-01 organization directory requires the Case stored Primary identity contract", async () => {
  const revoked = listRunner(false);
  const active = listRunner(true);

  assert.deepEqual(await service(revoked.runner).list(actor()), { documents: [] });
  assert.equal((await service(active.runner).list(actor())).documents.length, 1);

  for (const sql of [revoked.directoryQuery(), active.directoryQuery()]) {
    assert.match(sql, /primary_binding\.id=service_case\.primary_role_binding_id/);
    assert.match(sql, /primary_binding\.organization_id=service_case\.organization_id/);
    assert.match(sql, /primary_binding\.user_id=service_case\.primary_user_id/);
    assert.match(sql, /primary_binding\.role=service_case\.primary_role/);
    assert.match(sql, /primary_binding\.status='active'/);
    assert.match(sql, /primary_membership\.id=service_case\.primary_membership_id/);
    assert.match(sql, /primary_membership\.organization_id=service_case\.organization_id/);
    assert.match(sql, /primary_membership\.user_id=service_case\.primary_user_id/);
    assert.match(sql, /primary_membership\.status='active'/);
    assert.match(sql, /primary_actor\.id=service_case\.primary_user_id/);
    assert.match(sql, /primary_actor\.status='active'/);
    assert.match(sql, /ORDER BY version\.upload_generation DESC/);
  }
});

test("DOC-02 directory returns only the exact authoritative pending upload reference", async () => {
  const pending = listRunner(true, {
    latest_version_state: "pending_upload",
    latest_version_id: IDS[3],
    latest_version_record_version: 2,
  });
  const [document] = (await service(pending.runner).list(actor())).documents;
  assert.deepEqual(document?.pendingUpload, { id: IDS[3], recordVersion: 2 });
  assert.equal(JSON.stringify(document).includes("checksum"), false);
  assert.equal(JSON.stringify(document).includes("object_"), false);
});

function service(runner: TenantTransactionRunner): DocumentWorkspaceService {
  return new DocumentWorkspaceService(new PostgresqlDocumentWorkspaceRepository(runner));
}

function listRunner(
  storedPrimaryActive: boolean,
  override: Partial<DocumentRowFixture> = {},
) {
  let directoryQuery = "";
  const runner: TenantTransactionRunner = Object.freeze({
    async run<Result>(
      _context: TenantDatabaseContext,
      operation: (transaction: TenantTransaction) => Promise<Result>,
    ): Promise<Result> {
      const transaction: TenantTransaction = Object.freeze({
        async query<Row = Record<string, unknown>>(
          query: DatabaseQuery,
        ): Promise<DatabaseQueryResult<Row>> {
          if (query.text.includes("SELECT binding.role")) {
            // The actor remains authorized through another active Advisor binding.
            return result([{ role: "advisor" }]) as DatabaseQueryResult<Row>;
          }
          if (query.text.includes("FROM documents_documents AS document")) {
            directoryQuery = query.text;
            return result(storedPrimaryActive ? [{ ...documentRow(), ...override }] : []) as DatabaseQueryResult<Row>;
          }
          throw new Error("Unexpected DOC-01 directory query.");
        },
      });
      return operation(transaction);
    },
  });
  return Object.freeze({ runner, directoryQuery: () => directoryQuery });
}

interface DocumentRowFixture {
  readonly id: string;
  readonly service_case_id: string;
  readonly case_number: string;
  readonly display_name: string;
  readonly classification: string;
  readonly lifecycle_state: string;
  readonly latest_version_state: string | null;
  readonly latest_version_id: string | null;
  readonly latest_version_record_version: number | null;
  readonly has_active_version: boolean;
  readonly record_version: number;
  readonly updated_at: string;
}

function documentRow(): DocumentRowFixture {
  return Object.freeze({
    id: IDS[2],
    service_case_id: IDS[1],
    case_number: "DOC01-SYNTHETIC",
    display_name: "Synthetic Evidence",
    classification: "identity_and_case_evidence",
    lifecycle_state: "active",
    latest_version_state: null,
    latest_version_id: null,
    latest_version_record_version: null,
    has_active_version: false,
    record_version: 1,
    updated_at: "2026-08-23T00:00:00.000Z",
  });
}

function actor(): IdentitySessionActor {
  return Object.freeze({
    userId: IDS[0],
    organizationId: IDS[0],
    role: "advisor",
    sessionId: IDS[4],
    capturedSessionVersion: 1,
    reauthenticatedAtMs: null,
  });
}

function result(rows: readonly Record<string, unknown>[], rowCount = rows.length) {
  return Object.freeze({ rows, rowCount });
}
