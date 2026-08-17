import assert from "node:assert/strict";
import test from "node:test";

import { createOpaqueDocumentObjectKey } from "../../modules/documents/domain/contract.ts";
import {
  DocumentUploadError,
  DocumentUploadService,
} from "../../modules/documents/application/upload-service.ts";
import {
  DocumentUploadRuntimeUnavailable,
  getDocumentUploadRuntime,
} from "../../modules/documents/infrastructure/runtime.ts";
import { InMemoryDocumentUploadRepository } from "../fakes/document-upload.ts";

const ACTOR = Object.freeze({
  userId: "11111111-1111-4111-8111-111111111111",
  organizationId: "22222222-2222-4222-8222-222222222222",
  role: "advisor" as const,
  sessionId: "33333333-3333-4333-8333-333333333333",
  capturedSessionVersion: 1,
  reauthenticatedAtMs: 1_785_516_800_000,
});
const CASE_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_CASE_ID = "55555555-5555-4555-8555-555555555555";
const DOCUMENT_ID = "66666666-6666-4666-8666-666666666666";
const OTHER_DOCUMENT_ID = "77777777-7777-4777-8777-777777777777";
const CHECKSUM = "a".repeat(64);

class MutableClock {
  private current = 1_785_516_800_000;

  nowMs(): number {
    return this.current;
  }

  advance(milliseconds: number): void {
    this.current += milliseconds;
  }
}

function createService(repository: InMemoryDocumentUploadRepository, clock = new MutableClock()) {
  let nextId = 100;
  return {
    clock,
    service: new DocumentUploadService({
      repository,
      bucket: "synthetic-private-document-bucket",
      clock,
      policy: { maxSizeBytes: 10_000, intentTtlMs: 600_000 },
      createId: () => {
        nextId += 1;
        return `00000000-0000-4000-8000-${String(nextId).padStart(12, "0")}`;
      },
    }),
  };
}

function command(overrides: Record<string, unknown> = {}) {
  return {
    documentId: DOCUMENT_ID,
    checksumSha256: CHECKSUM,
    sizeBytes: 1_024,
    contentType: "application/pdf",
    requestId: "document-upload-intent-001",
    idempotencyKey: "document-upload-p1-10-001",
    ...overrides,
  };
}

function readyRepository(): InMemoryDocumentUploadRepository {
  const repository = new InMemoryDocumentUploadRepository();
  repository.registerDocument({
    documentId: DOCUMENT_ID,
    organizationId: ACTOR.organizationId,
    caseId: CASE_ID,
  });
  repository.registerDocument({
    documentId: OTHER_DOCUMENT_ID,
    organizationId: ACTOR.organizationId,
    caseId: OTHER_CASE_ID,
  });
  repository.authorizeCurrentCase({
    organizationId: ACTOR.organizationId,
    userId: ACTOR.userId,
    caseId: CASE_ID,
  });
  return repository;
}

test("an authorized case upload creates one opaque quarantined version with redacted effects", async () => {
  const repository = readyRepository();
  const { service } = createService(repository);

  const result = await service.createCaseUploadIntent({
    actor: ACTOR,
    caseId: CASE_ID,
    command: command(),
  });

  assert.deepEqual(result, {
    documentId: DOCUMENT_ID,
    documentVersionId: "00000000-0000-4000-8000-000000000101",
    state: "quarantined",
    expiresAtMs: 1_785_517_400_000,
    upload: {
      url: result.upload.url,
      method: "PUT",
      expiresAtMs: 1_785_517_400_000,
      headers: {
        "content-length": "1024",
        "content-type": "application/pdf",
        "x-amz-checksum-sha256": CHECKSUM,
      },
    },
  });
  assert.match(result.upload.url, /^https:\/\//);
  assert.equal(JSON.stringify(result).includes("bucket"), false);
  assert.equal(JSON.stringify(result).includes("documents/"), false);
  assert.deepEqual(repository.snapshot(), {
    idempotency: 1,
    versions: 1,
    audits: 1,
    outbox: 1,
  });

  const version = repository.version(result.documentVersionId);
  assert.ok(version);
  assert.equal(version.state, "quarantined");
  assert.equal(version.object.versionId, null);
  assert.equal(
    version.object.key,
    createOpaqueDocumentObjectKey(DOCUMENT_ID, result.documentVersionId),
  );
  assert.equal(repository.auditPayload().includes(CHECKSUM), false);
  assert.equal(repository.auditPayload().includes("application/pdf"), false);
  assert.equal(repository.outboxPayload().includes(CHECKSUM), false);
  assert.equal(repository.outboxPayload().includes("application/pdf"), false);
});

test("the same idempotency command replays one quarantined version and changed reuse is denied", async () => {
  const repository = readyRepository();
  const { service } = createService(repository);
  const input = { actor: ACTOR, caseId: CASE_ID, command: command() };

  const first = await service.createCaseUploadIntent(input);
  assert.deepEqual(await service.createCaseUploadIntent(input), first);
  assert.deepEqual(repository.snapshot(), {
    idempotency: 1,
    versions: 1,
    audits: 1,
    outbox: 1,
  });
  await assert.rejects(
    service.createCaseUploadIntent({
      ...input,
      command: command({ checksumSha256: "b".repeat(64) }),
    }),
    documentUploadError("DOCUMENT_UPLOAD_IDEMPOTENCY_KEY_REUSED"),
  );
});

test("cross-case and unauthorized requests reveal no document fact", async () => {
  const repository = readyRepository();
  const { service } = createService(repository);

  await assert.rejects(
    service.createCaseUploadIntent({
      actor: ACTOR,
      caseId: CASE_ID,
      command: command({ documentId: OTHER_DOCUMENT_ID }),
    }),
    documentUploadError("DOCUMENT_UPLOAD_CASE_FORBIDDEN"),
  );
  await assert.rejects(
    service.createCaseUploadIntent({
      actor: ACTOR,
      caseId: OTHER_CASE_ID,
      command: command({ idempotencyKey: "document-upload-p1-10-002" }),
    }),
    documentUploadError("DOCUMENT_UPLOAD_CASE_FORBIDDEN"),
  );
  assert.deepEqual(repository.snapshot(), {
    idempotency: 0,
    versions: 0,
    audits: 0,
    outbox: 0,
  });
});

test("expired replay and invalid checksum, size, or type are denied without partial facts", async () => {
  const repository = readyRepository();
  const { service, clock } = createService(repository);
  const input = { actor: ACTOR, caseId: CASE_ID, command: command() };

  await service.createCaseUploadIntent(input);
  clock.advance(600_001);
  await assert.rejects(
    service.createCaseUploadIntent(input),
    documentUploadError("DOCUMENT_UPLOAD_INTENT_EXPIRED"),
  );

  const invalidRepository = readyRepository();
  const { service: invalidService } = createService(invalidRepository);
  for (const invalidCommand of [
    command({ checksumSha256: "A".repeat(64) }),
    command({ sizeBytes: 10_001 }),
    command({ contentType: "application/pdf; charset=utf-8" }),
  ]) {
    await assert.rejects(
      invalidService.createCaseUploadIntent({
        actor: ACTOR,
        caseId: CASE_ID,
        command: invalidCommand,
      }),
      documentUploadError("DOCUMENT_UPLOAD_INVALID"),
    );
  }
  assert.deepEqual(invalidRepository.snapshot(), {
    idempotency: 0,
    versions: 0,
    audits: 0,
    outbox: 0,
  });
});

test("a transaction failure leaves version, idempotency, audit, and outbox empty", async () => {
  const repository = readyRepository();
  repository.failOnceBeforeCommit();
  const { service } = createService(repository);

  await assert.rejects(
    service.createCaseUploadIntent({ actor: ACTOR, caseId: CASE_ID, command: command() }),
    /synthetic transaction failure/,
  );
  assert.deepEqual(repository.snapshot(), {
    idempotency: 0,
    versions: 0,
    audits: 0,
    outbox: 0,
  });
});

test("the document runtime fails closed without a configured HK RDS and S3 adapter", () => {
  assert.throws(() => getDocumentUploadRuntime(), DocumentUploadRuntimeUnavailable);
});

function documentUploadError(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof DocumentUploadError && error.code === code;
}
