import assert from "node:assert/strict";
import test from "node:test";

import { hashRequestPayload } from "../../../modules/shared/public.ts";
import type {
  DatabaseQuery,
  DatabaseQueryResult,
  TenantDatabaseContext,
  TenantTransaction,
  TenantTransactionRunner,
} from "../../../modules/shared/server.ts";
import {
  DocumentTransferError,
  DocumentTransferService,
} from "../../../modules/documents/application/transfer-service.ts";
import { PostgresqlDocumentTransferRepository } from
  "../../../modules/documents/infrastructure/postgresql-transfer-repository.ts";
import type { IdentitySessionActor } from "../../../modules/identity/public.ts";

const IDS = Object.freeze({
  organization: "51000000-0000-4000-8000-000000000001",
  actor: "81000000-0000-4000-8000-000000000101",
  session: "81000000-0000-4000-8000-000000000102",
  case: "81000000-0000-4000-8000-000000000103",
  document: "81000000-0000-4000-8000-000000000104",
  version: "81000000-0000-4000-8000-000000000105",
  audit: "81000000-0000-4000-8000-000000000106",
  outbox: "81000000-0000-4000-8000-000000000107",
});

test("abandonment locks authority and latest pending generation before two exact version bumps", async () => {
  const queries: DatabaseQuery[] = [];
  const service = createService(runner(async (query) => {
    queries.push(query);
    if (query.text.includes("INSERT INTO shared_idempotency_records")) return rows([{ id: IDS.audit }]);
    if (query.text.includes("SELECT request_hash,state,result_reference")) return rows([]);
    if (query.text.includes("SELECT binding.role")) return rows([{ role: "founder" }]);
    if (query.text.includes("SELECT service_case.id")) {
      return rows([{ id: IDS.case, stage: "signed", student_status: "active" }]);
    }
    if (query.text.includes("FROM documents_documents") && query.text.includes("owner_kind='case'")) {
      return rows([{
        id: IDS.document,
        lifecycle_state: "active",
        record_version: 2,
        active_document_version_id: null,
      }]);
    }
    if (query.text.includes("FROM documents_document_versions") && query.text.includes("FOR UPDATE")) {
      return rows([versionRow("pending_upload")]);
    }
    if (query.text.includes("SELECT NOT EXISTS")) return rows([{ is_latest: true }]);
    if (query.text.includes("UPDATE documents_document_versions")) return rows([], 1);
    if (query.text.includes("UPDATE documents_documents")) return rows([], 1);
    if (query.text.includes("INSERT INTO audit_events") || query.text.includes("INSERT INTO audit_outbox")) {
      assert.equal(JSON.stringify(query.values).includes("documents/"), false);
      return rows([], 1);
    }
    if (query.text.includes("UPDATE shared_idempotency_records")) return rows([], 1);
    throw new Error("Unexpected abandonment repository query.");
  }));

  assert.deepEqual(await abandon(service, "doc02-abandon-repository"), {
    id: IDS.version,
    recordVersion: 2,
  });
  assert.ok(queries.some(({ text }) => /FROM documents_documents[\s\S]*FOR UPDATE/u.test(text)));
  assert.ok(queries.some(({ text }) => /FROM documents_document_versions[\s\S]*FOR UPDATE/u.test(text)));
  assert.ok(queries.some(({ text }) => /SET state='abandoned'/u.test(text)));
  assert.ok(queries.some(({ text }) => /newer\.upload_generation>\$3/u.test(text)));
  assert.equal(queries.filter(({ text }) => text.includes("INSERT INTO audit_events")).length, 1);
  assert.equal(queries.filter(({ text }) => text.includes("INSERT INTO audit_outbox")).length, 1);
});

test("exact abandonment replay returns the first acknowledgement without repeated state or effects", async () => {
  let requestHash = "";
  const queries: string[] = [];
  const service = createService(runner(async (query) => {
    queries.push(query.text);
    if (query.text.includes("INSERT INTO shared_idempotency_records")) {
      requestHash = String(query.values?.[4]);
      return rows([], 0);
    }
    if (query.text.includes("SELECT request_hash,state,result_reference")) {
      return rows([{
        request_hash: requestHash,
        state: "completed",
        result_reference: `${IDS.version}:2`,
        response_hash: hashRequestPayload({ id: IDS.version, record_version: 2 }),
      }]);
    }
    if (query.text.includes("SELECT binding.role")) return rows([{ role: "founder" }]);
    if (query.text.includes("SELECT service_case.id")) {
      return rows([{ id: IDS.case, stage: "signed", student_status: "active" }]);
    }
    if (query.text.includes("FROM documents_documents") && query.text.includes("owner_kind='case'")) {
      return rows([{
        id: IDS.document,
        lifecycle_state: "active",
        record_version: 3,
        active_document_version_id: null,
      }]);
    }
    if (query.text.includes("FROM documents_document_versions") && query.text.includes("FOR UPDATE")) {
      return rows([versionRow("abandoned", 2)]);
    }
    throw new Error("Replay must not mutate business state or effects.");
  }));

  assert.deepEqual(await abandon(service, "doc02-abandon-replay"), {
    id: IDS.version,
    recordVersion: 2,
  });
  assert.equal(queries.some((sql) => sql.includes("SET state='abandoned'")), false);
  assert.equal(queries.some((sql) => sql.includes("INSERT INTO audit_events")), false);
});

test("a new abandonment key conflicts after receipt or prior abandonment wins", async () => {
  for (const state of ["abandoned", "quarantined"] as const) {
    const service = createService(runner(async (query) => {
      if (query.text.includes("INSERT INTO shared_idempotency_records")) return rows([{ id: IDS.audit }]);
      if (query.text.includes("SELECT request_hash,state,result_reference")) return rows([]);
      if (query.text.includes("SELECT binding.role")) return rows([{ role: "founder" }]);
      if (query.text.includes("SELECT service_case.id")) {
        return rows([{ id: IDS.case, stage: "signed", student_status: "active" }]);
      }
      if (query.text.includes("FROM documents_documents") && query.text.includes("owner_kind='case'")) {
        return rows([{
          id: IDS.document,
          lifecycle_state: "active",
          record_version: 3,
          active_document_version_id: null,
        }]);
      }
      if (query.text.includes("FROM documents_document_versions") && query.text.includes("FOR UPDATE")) {
        return rows([versionRow(state, 2, state === "quarantined" ? "provider-v1" : null)]);
      }
      throw new Error("Non-pending state must stop before mutation.");
    }));
    await assert.rejects(
      () => abandon(service, `doc02-abandon-conflict-${state}`),
      (error: unknown) => error instanceof DocumentTransferError &&
        error.code === "DOCUMENT_TRANSFER_CONFLICT",
    );
  }
});

function createService(transactionRunner: TenantTransactionRunner): DocumentTransferService {
  const ids = [IDS.audit, IDS.outbox];
  return new DocumentTransferService({
    repository: new PostgresqlDocumentTransferRepository(transactionRunner),
    signer: {
      async issueUploadIntent() { return { url: "http://127.0.0.1:4566/upload" }; },
      async issueDownloadIntent() { return { url: "http://127.0.0.1:4566/download" }; },
    },
    bucket: "tianxing-documents-local",
    allowedHttpOrigin: "http://127.0.0.1:4566",
    createId: () => ids.shift() ?? IDS.audit,
    now: () => Date.UTC(2026, 7, 24, 10, 0, 0),
  });
}

function abandon(service: DocumentTransferService, idempotencyKey: string) {
  return service.abandonPendingUpload({
    actor: actor(),
    caseId: IDS.case,
    documentId: IDS.document,
    versionId: IDS.version,
    command: {
      expectedDocumentRecordVersion: 2,
      expectedVersionRecordVersion: 1,
      requestId: idempotencyKey,
      idempotencyKey,
    },
  });
}

function versionRow(
  state: string,
  recordVersion = 1,
  providerVersion: string | null = null,
) {
  return {
    id: IDS.version,
    document_id: IDS.document,
    record_version: recordVersion,
    detected_content_type: "application/pdf",
    checksum_sha256: "a".repeat(64),
    object_bucket: "tianxing-documents-local",
    object_key: `documents/${IDS.document}/versions/${IDS.version}`,
    object_version_id: providerVersion,
    state,
    revoked_at: null,
    upload_generation: 1,
  };
}

function actor(): IdentitySessionActor {
  return {
    userId: IDS.actor,
    organizationId: IDS.organization,
    role: "founder",
    sessionId: IDS.session,
    capturedSessionVersion: 1,
    reauthenticatedAtMs: null,
  };
}

function runner(
  query: (input: DatabaseQuery) => Promise<DatabaseQueryResult<Record<string, unknown>>>,
): TenantTransactionRunner {
  return Object.freeze({
    async run<Result>(
      _context: TenantDatabaseContext,
      operation: (transaction: TenantTransaction) => Promise<Result>,
    ): Promise<Result> {
      return operation(Object.freeze({
        async query<Row = Record<string, unknown>>(input: DatabaseQuery) {
          return await query(input) as DatabaseQueryResult<Row>;
        },
      }));
    },
  });
}

function rows(values: readonly Record<string, unknown>[], rowCount = values.length) {
  return Promise.resolve(Object.freeze({ rows: values, rowCount }));
}
