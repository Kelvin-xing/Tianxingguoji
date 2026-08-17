import assert from "node:assert/strict";
import test from "node:test";

import {
  createOpaqueDocumentObjectKey,
  type DocumentRecord,
  type DocumentVersionRecord,
} from "../../modules/documents/domain/contract.ts";
import {
  DocumentVersionRuntimeUnavailable,
  getDocumentVersionRuntime,
} from "../../modules/documents/infrastructure/version-runtime.ts";
import {
  DocumentVersionError,
  DocumentVersionService,
} from "../../modules/documents/application/version-service.ts";
import { InMemoryDocumentVersionRepository } from "../fakes/document-version.ts";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const CASE_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_CASE_ID = "33333333-3333-4333-8333-333333333333";
const DOCUMENT_ID = "44444444-4444-4444-8444-444444444444";
const CURRENT_VERSION_ID = "55555555-5555-4555-8555-555555555555";
const CLEAN_TARGET_VERSION_ID = "66666666-6666-4666-8666-666666666666";
const UNCLEAN_VERSION_ID = "77777777-7777-4777-8777-777777777777";
const ACTOR = Object.freeze({
  userId: "88888888-8888-4888-8888-888888888888",
  organizationId: ORGANIZATION_ID,
  role: "advisor" as const,
  sessionId: "99999999-9999-4999-8999-999999999999",
  capturedSessionVersion: 1,
  reauthenticatedAtMs: 1_785_600_000_000,
});
const BUCKET = "synthetic-private-document-bucket";

class MutableClock {
  private current = 1_785_600_000_000;

  nowMs(): number {
    return this.current;
  }

  advance(milliseconds: number): void {
    this.current += milliseconds;
  }
}

function createService(repository: InMemoryDocumentVersionRepository, clock = new MutableClock()) {
  let nextId = 900;
  return {
    clock,
    service: new DocumentVersionService({
      repository,
      clock,
      createId: () => {
        nextId += 1;
        return `00000000-0000-4000-8000-${String(nextId).padStart(12, "0")}`;
      },
    }),
  };
}

function makeDocument(overrides: Partial<DocumentRecord> = {}): DocumentRecord {
  return {
    id: DOCUMENT_ID,
    organizationId: ORGANIZATION_ID,
    owner: { kind: "case", id: CASE_ID },
    classification: "identity_and_case_evidence",
    lifecycleState: "active",
    activeVersionId: CURRENT_VERSION_ID,
    legalHold: false,
    legalHoldReason: null,
    softDeletedAt: null,
    retentionEndsAt: null,
    recordVersion: 3,
    ...overrides,
  };
}

function makeVersion(
  id: string,
  overrides: Partial<DocumentVersionRecord> = {},
): DocumentVersionRecord {
  return {
    id,
    organizationId: ORGANIZATION_ID,
    documentId: DOCUMENT_ID,
    object: {
      region: "ap-east-1",
      bucket: BUCKET,
      key: createOpaqueDocumentObjectKey(DOCUMENT_ID, id),
      versionId: `s3-version-${id.slice(0, 8)}`,
    },
    checksumSha256: "a".repeat(64),
    sizeBytes: 1_024,
    detectedContentType: "application/pdf",
    uploadedBy: ACTOR.userId,
    state: "available",
    revokedAt: null,
    recordVersion: 1,
    ...overrides,
  };
}

function readyRepository(document = makeDocument()): InMemoryDocumentVersionRepository {
  const repository = new InMemoryDocumentVersionRepository();
  repository.registerDocument({
    caseId: CASE_ID,
    record: document,
    versions: [
      makeVersion(CURRENT_VERSION_ID),
      makeVersion(CLEAN_TARGET_VERSION_ID),
      makeVersion(UNCLEAN_VERSION_ID, { state: "quarantined" }),
    ],
  });
  repository.authorizeCurrentCase({
    organizationId: ORGANIZATION_ID,
    userId: ACTOR.userId,
    caseId: CASE_ID,
  });
  return repository;
}

function rollbackCommand(overrides: Record<string, unknown> = {}) {
  return {
    targetVersionId: CLEAN_TARGET_VERSION_ID,
    expectedRecordVersion: 3,
    requestId: "document-version-rollback-001",
    idempotencyKey: "document-version-rollback-001",
    ...overrides,
  };
}

function deleteCommand(overrides: Record<string, unknown> = {}) {
  return {
    expectedRecordVersion: 3,
    requestId: "document-delete-001",
    idempotencyKey: "document-delete-001",
    ...overrides,
  };
}

function restoreCommand(overrides: Record<string, unknown> = {}) {
  return {
    versionId: CLEAN_TARGET_VERSION_ID,
    expectedRecordVersion: 4,
    requestId: "document-restore-001",
    idempotencyKey: "document-restore-001",
    ...overrides,
  };
}

test("a clean available version creates an audited pointer revision and exact replay has no second effect", async () => {
  const repository = readyRepository();
  const { service } = createService(repository);
  const input = {
    actor: ACTOR,
    caseId: CASE_ID,
    documentId: DOCUMENT_ID,
    command: rollbackCommand(),
  };

  const first = await service.rollbackToCleanVersion(input);
  assert.deepEqual(first, {
    documentId: DOCUMENT_ID,
    activeVersionId: CLEAN_TARGET_VERSION_ID,
    lifecycleState: "active",
    recordVersion: 4,
  });
  assert.deepEqual(await service.rollbackToCleanVersion(input), first);
  assert.equal(repository.document(DOCUMENT_ID)?.activeVersionId, CLEAN_TARGET_VERSION_ID);
  assert.equal(repository.document(DOCUMENT_ID)?.recordVersion, 4);
  assert.deepEqual(repository.version(CURRENT_VERSION_ID), makeVersion(CURRENT_VERSION_ID));
  assert.deepEqual(repository.snapshot(), {
    documents: 1,
    versions: 3,
    idempotency: 1,
    audits: 1,
    outbox: 1,
  });
  const effects = repository.effectPayload();
  assert.equal(effects.includes(BUCKET), false);
  assert.equal(effects.includes("documents/"), false);
  assert.equal(effects.includes("application/pdf"), false);
  assert.equal(effects.includes("identity_and_case_evidence"), false);
});

test("rollback rejects a non-clean target without changing pointer, audit, outbox, or idempotency", async () => {
  const repository = readyRepository();
  const { service } = createService(repository);

  await assert.rejects(
    service.rollbackToCleanVersion({
      actor: ACTOR,
      caseId: CASE_ID,
      documentId: DOCUMENT_ID,
      command: rollbackCommand({ targetVersionId: UNCLEAN_VERSION_ID }),
    }),
    documentVersionError("DOCUMENT_VERSION_CLEAN_VERSION_REQUIRED"),
  );
  assert.equal(repository.document(DOCUMENT_ID)?.activeVersionId, CURRENT_VERSION_ID);
  assert.deepEqual(repository.snapshot(), {
    documents: 1,
    versions: 3,
    idempotency: 0,
    audits: 0,
    outbox: 0,
  });
});

test("legal hold blocks soft deletion, while a permitted delete is audited, idempotent, and does not hard-delete history", async () => {
  const heldRepository = readyRepository(
    makeDocument({ legalHold: true, legalHoldReason: "synthetic_hold" }),
  );
  const { service: heldService } = createService(heldRepository);
  await assert.rejects(
    heldService.softDeleteDocument({
      actor: ACTOR,
      caseId: CASE_ID,
      documentId: DOCUMENT_ID,
      command: deleteCommand(),
    }),
    documentVersionError("DOCUMENT_VERSION_DELETE_LEGAL_HOLD"),
  );
  assert.deepEqual(heldRepository.snapshot(), {
    documents: 1,
    versions: 3,
    idempotency: 0,
    audits: 0,
    outbox: 0,
  });

  const repository = readyRepository();
  const { service } = createService(repository);
  const input = {
    actor: ACTOR,
    caseId: CASE_ID,
    documentId: DOCUMENT_ID,
    command: deleteCommand(),
  };
  const result = await service.softDeleteDocument(input);
  assert.deepEqual(result, {
    documentId: DOCUMENT_ID,
    activeVersionId: CURRENT_VERSION_ID,
    lifecycleState: "pending_delete",
    recordVersion: 4,
  });
  assert.deepEqual(await service.softDeleteDocument(input), result);
  assert.equal(repository.document(DOCUMENT_ID)?.softDeletedAt, "2026-08-01T16:00:00.000Z");
  assert.equal(repository.version(CURRENT_VERSION_ID)?.state, "available");
  assert.deepEqual(repository.snapshot(), {
    documents: 1,
    versions: 3,
    idempotency: 1,
    audits: 1,
    outbox: 1,
  });
});

test("restore inside the 30-day window targets a clean version and is audited without rewriting versions", async () => {
  const repository = readyRepository();
  const { service } = createService(repository);
  await service.softDeleteDocument({
    actor: ACTOR,
    caseId: CASE_ID,
    documentId: DOCUMENT_ID,
    command: deleteCommand(),
  });

  await assert.rejects(
    service.restoreDocument({
      actor: ACTOR,
      caseId: CASE_ID,
      documentId: DOCUMENT_ID,
      command: restoreCommand({
        versionId: UNCLEAN_VERSION_ID,
        idempotencyKey: "document-restore-unclean",
      }),
    }),
    documentVersionError("DOCUMENT_VERSION_CLEAN_VERSION_REQUIRED"),
  );

  const restoreInput = {
    actor: ACTOR,
    caseId: CASE_ID,
    documentId: DOCUMENT_ID,
    command: restoreCommand(),
  };
  const result = await service.restoreDocument(restoreInput);
  assert.deepEqual(result, {
    documentId: DOCUMENT_ID,
    activeVersionId: CLEAN_TARGET_VERSION_ID,
    lifecycleState: "active",
    recordVersion: 5,
  });
  assert.equal(repository.document(DOCUMENT_ID)?.softDeletedAt, null);
  assert.equal(repository.version(CLEAN_TARGET_VERSION_ID)?.state, "available");
  assert.deepEqual(await service.restoreDocument(restoreInput), result);
  assert.deepEqual(repository.snapshot(), {
    documents: 1,
    versions: 3,
    idempotency: 2,
    audits: 2,
    outbox: 2,
  });
});

test("an expired soft-delete window rejects restore before idempotency, audit, or outbox facts", async () => {
  const repository = readyRepository(
    makeDocument({
      lifecycleState: "pending_delete",
      softDeletedAt: "2026-06-01T00:00:00.000Z",
      recordVersion: 4,
    }),
  );
  const { service } = createService(repository);

  await assert.rejects(
    service.restoreDocument({
      actor: ACTOR,
      caseId: CASE_ID,
      documentId: DOCUMENT_ID,
      command: restoreCommand(),
    }),
    documentVersionError("DOCUMENT_VERSION_RESTORE_WINDOW_EXPIRED"),
  );
  assert.deepEqual(repository.snapshot(), {
    documents: 1,
    versions: 3,
    idempotency: 0,
    audits: 0,
    outbox: 0,
  });
});

test("stale pointers and cross-case requests disclose no document fact or effect", async () => {
  const repository = readyRepository();
  const { service } = createService(repository);
  await assert.rejects(
    service.rollbackToCleanVersion({
      actor: ACTOR,
      caseId: CASE_ID,
      documentId: DOCUMENT_ID,
      command: rollbackCommand({ expectedRecordVersion: 2 }),
    }),
    documentVersionError("DOCUMENT_VERSION_STALE"),
  );
  await assert.rejects(
    service.rollbackToCleanVersion({
      actor: ACTOR,
      caseId: OTHER_CASE_ID,
      documentId: DOCUMENT_ID,
      command: rollbackCommand({ idempotencyKey: "document-version-rollback-cross-case" }),
    }),
    documentVersionError("DOCUMENT_VERSION_CASE_FORBIDDEN"),
  );
  assert.equal(repository.document(DOCUMENT_ID)?.activeVersionId, CURRENT_VERSION_ID);
  assert.deepEqual(repository.snapshot(), {
    documents: 1,
    versions: 3,
    idempotency: 0,
    audits: 0,
    outbox: 0,
  });
});

test("a failed transaction preserves the old document pointer and has no partial durable facts", async () => {
  const repository = readyRepository();
  repository.failOnceBeforeCommit();
  const { service } = createService(repository);

  await assert.rejects(
    service.rollbackToCleanVersion({
      actor: ACTOR,
      caseId: CASE_ID,
      documentId: DOCUMENT_ID,
      command: rollbackCommand(),
    }),
    /synthetic document version transaction failure/,
  );
  assert.equal(repository.document(DOCUMENT_ID)?.activeVersionId, CURRENT_VERSION_ID);
  assert.equal(repository.document(DOCUMENT_ID)?.recordVersion, 3);
  assert.deepEqual(repository.snapshot(), {
    documents: 1,
    versions: 3,
    idempotency: 0,
    audits: 0,
    outbox: 0,
  });
});

test("the document version runtime fails closed without an HK RDS composition", () => {
  assert.throws(() => getDocumentVersionRuntime(), DocumentVersionRuntimeUnavailable);
});

function documentVersionError(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof DocumentVersionError && error.code === code;
}
