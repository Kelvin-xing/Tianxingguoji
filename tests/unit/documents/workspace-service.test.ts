import assert from "node:assert/strict";
import test from "node:test";

import type { IdentitySessionActor } from "../../../modules/identity/public.ts";
import {
  DocumentWorkspaceError,
  DocumentWorkspaceService,
  isDocumentWorkspaceError,
  type DocumentWorkspaceRepository,
} from "../../../modules/documents/application/workspace-service.ts";

const IDS = [
  "81000000-0000-4000-8000-000000000001",
  "81000000-0000-4000-8000-000000000002",
  "81000000-0000-4000-8000-000000000003",
  "81000000-0000-4000-8000-000000000004",
  "81000000-0000-4000-8000-000000000005",
] as const;

test("DOC-01 service enforces read/create capabilities and canonical registration", async () => {
  const registrations: unknown[] = [];
  const repository = {
    list: async () => ({ documents: [] }),
    detail: async () => null,
    register: async (input: unknown) => {
      registrations.push(input);
      return { id: IDS[2], recordVersion: 1 };
    },
  } satisfies DocumentWorkspaceRepository;
  let index = 2;
  const service = new DocumentWorkspaceService(
    repository,
    () => IDS[index++]!,
    () => Date.parse("2026-08-23T00:00:00.000Z"),
  );

  assert.deepEqual(await service.register({
    actor: actor("advisor"),
    caseId: IDS[1],
    command: {
      displayName: "Synthetic Case Evidence",
      classification: "identity_and_case_evidence",
      requestId: "doc-01-request",
      idempotencyKey: "doc-01-registration",
    },
  }), { id: IDS[2], recordVersion: 1 });
  const registration = registrations[0] as Record<string, unknown>;
  assert.equal(registration.documentId, IDS[2]);
  assert.equal(registration.displayName, "Synthetic Case Evidence");
  assert.equal(registration.classification, "identity_and_case_evidence");
  assert.equal(typeof registration.requestHash, "string");
  assert.doesNotMatch(JSON.stringify(registration.effects), /Synthetic Case Evidence/);

  for (const role of ["admin", "data_reviewer", "contractor"] as const) {
    assert.throws(
      () => service.register({
        actor: actor(role),
        caseId: IDS[1],
        command: {
          displayName: "Synthetic Case Evidence",
          classification: "identity_and_case_evidence",
          requestId: "doc-01-denied",
          idempotencyKey: `doc-01-${role}`,
        },
      }),
      (error) => isDocumentWorkspaceError(error, "DOCUMENT_WORKSPACE_FORBIDDEN"),
    );
    assert.throws(
      () => service.list(actor(role)),
      (error) => isDocumentWorkspaceError(error, "DOCUMENT_WORKSPACE_FORBIDDEN"),
    );
  }
  assert.equal(registrations.length, 1);
});

test("DOC-01 service rejects non-canonical registration fields before repository access", async () => {
  let calls = 0;
  const repository = {
    list: async () => ({ documents: [] }),
    detail: async () => null,
    register: async () => { calls += 1; return { id: IDS[2], recordVersion: 1 }; },
  } satisfies DocumentWorkspaceRepository;
  const service = new DocumentWorkspaceService(repository);
  for (const command of [
    { displayName: " padded", classification: "identity_and_case_evidence" },
    { displayName: "", classification: "identity_and_case_evidence" },
    { displayName: "x".repeat(201), classification: "identity_and_case_evidence" },
    { displayName: "Synthetic", classification: "temporary_upload" },
  ]) {
    assert.throws(
      () => service.register({
        actor: actor("founder"),
        caseId: IDS[1],
        command: { ...command, requestId: "doc-01-invalid", idempotencyKey: "doc-01-invalid" },
      }),
      (error) => isDocumentWorkspaceError(error, "DOCUMENT_WORKSPACE_INVALID"),
    );
  }
  assert.equal(calls, 0);
});

test("DOC-01 stable guard accepts only Error name plus an allowlisted code", () => {
  const equivalent = Object.assign(new Error("redacted"), {
    name: "DocumentWorkspaceError",
    code: "DOCUMENT_WORKSPACE_CONFLICT",
  });
  assert.equal(isDocumentWorkspaceError(equivalent, "DOCUMENT_WORKSPACE_CONFLICT"), true);
  assert.equal(isDocumentWorkspaceError({
    name: "DocumentWorkspaceError",
    code: "DOCUMENT_WORKSPACE_CONFLICT",
  }), false);
  assert.equal(isDocumentWorkspaceError(Object.assign(new Error(), {
    name: "DocumentWorkspaceError",
    code: "UNKNOWN",
  })), false);
  assert.equal(new DocumentWorkspaceError("DOCUMENT_WORKSPACE_INVALID").name,
    "DocumentWorkspaceError");
});

function actor(role: IdentitySessionActor["role"]): IdentitySessionActor {
  return Object.freeze({
    userId: IDS[0],
    organizationId: IDS[1],
    role,
    sessionId: IDS[4],
    capturedSessionVersion: 1,
    reauthenticatedAtMs: null,
  });
}
