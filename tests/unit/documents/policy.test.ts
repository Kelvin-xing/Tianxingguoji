import assert from "node:assert/strict";
import test from "node:test";

import { DOCUMENT_OBJECT_REGION } from "../../../modules/documents/contract.ts";
import {
  DOCUMENT_EXPORT_MAX_TTL_MS,
  DOCUMENT_POLICY_VERSION,
  DocumentPolicyError,
  DocumentPolicyService,
  evaluateDocumentCleanupPolicy,
  evaluateDocumentExportPolicy,
  resolveDocumentRetention,
  type DocumentPolicyActor,
  type DocumentPolicyRepository,
  type DocumentRetentionContext,
} from "../../../modules/documents/policy.ts";
import {
  DocumentPolicyRuntimeUnavailable,
  getDocumentPolicyRuntime as getFailClosedPolicyRuntime,
} from "../../../modules/documents/policy-runtime.ts";

const ids = Object.freeze({
  organization: "11111111-1111-4111-8111-111111111111",
  founder: "22222222-2222-4222-8222-222222222222",
  case: "33333333-3333-4333-8333-333333333333",
  document: "44444444-4444-4444-8444-444444444444",
  export: "55555555-5555-4555-8555-555555555555",
  audit: "66666666-6666-4666-8666-666666666666",
  outbox: "77777777-7777-4777-8777-777777777777",
});

const nowMs = Date.UTC(2026, 7, 7, 9, 0, 0);

function founder(isFounder = true): DocumentPolicyActor {
  return {
    organizationId: ids.organization,
    userId: ids.founder,
    isFounder,
  };
}

function caseEvidenceRetention(): DocumentRetentionContext {
  return {
    policyVersion: DOCUMENT_POLICY_VERSION,
    classification: "identity_and_case_evidence",
    documentCreatedAtMs: Date.UTC(2025, 0, 1),
    attachedToCase: true,
    caseClosedAtMs: Date.UTC(2026, 1, 28, 10, 30, 0),
  };
}

function fakeRepository(): DocumentPolicyRepository {
  return {
    async mutateLegalHold(input) {
      return {
        documentId: input.documentId,
        legalHold: input.command.action === "place",
        recordVersion: input.command.expectedRecordVersion + 1,
        receipt: { auditEventId: ids.audit, outboxMessageId: ids.outbox },
      };
    },
    async createExportGrant(input) {
      return {
        exportId: ids.export,
        documentId: input.documentId,
        expiresAtMs: input.command.expiresAtMs,
        remainingUses: 1,
        watermarkRequired: true,
        storageRegion: DOCUMENT_OBJECT_REGION,
        receipt: { auditEventId: ids.audit, outboxMessageId: ids.outbox },
      };
    },
    async consumeExportGrant() {
      return {
        location: "https://private-export.example.test/one-use-token",
        expiresAtMs: nowMs + 60_000,
        watermarkRequired: true,
        storageRegion: DOCUMENT_OBJECT_REGION,
        receipt: { auditEventId: ids.audit, outboxMessageId: ids.outbox },
      };
    },
  };
}

function service(): DocumentPolicyService {
  return new DocumentPolicyService({
    repository: fakeRepository(),
    clock: { nowMs: () => nowMs },
  });
}

test("OD-02 retention schedules use the approved case-close and creation anchors", () => {
  const caseEvidence = resolveDocumentRetention(caseEvidenceRetention());
  assert.deepEqual(caseEvidence, {
    allowed: true,
    value: {
      policyVersion: DOCUMENT_POLICY_VERSION,
      classification: "identity_and_case_evidence",
      retentionEndsAtMs: Date.UTC(2033, 1, 28, 10, 30, 0),
      scheduleAnchor: "case_closure",
    },
  });

  const operational = resolveDocumentRetention({
    ...caseEvidenceRetention(),
    classification: "operational_attachment",
  });
  assert.equal(operational.allowed, true);
  if (operational.allowed) {
    assert.equal(operational.value.retentionEndsAtMs, Date.UTC(2028, 1, 28, 10, 30, 0));
  }

  const temporary = resolveDocumentRetention({
    policyVersion: DOCUMENT_POLICY_VERSION,
    classification: "temporary_upload",
    documentCreatedAtMs: nowMs,
    attachedToCase: false,
    caseClosedAtMs: null,
  });
  assert.deepEqual(temporary, {
    allowed: true,
    value: {
      policyVersion: DOCUMENT_POLICY_VERSION,
      classification: "temporary_upload",
      retentionEndsAtMs: nowMs + 30 * 24 * 60 * 60 * 1000,
      scheduleAnchor: "document_creation",
    },
  });
});

test("unknown classes and incompatible temporary-upload context fail closed", () => {
  assert.deepEqual(resolveDocumentRetention({
    ...caseEvidenceRetention(),
    classification: "unreviewed_attachment",
  }), {
    allowed: false,
    code: "DOCUMENT_POLICY_UNKNOWN_CLASSIFICATION",
  });
  assert.deepEqual(resolveDocumentRetention({
    policyVersion: DOCUMENT_POLICY_VERSION,
    classification: "temporary_upload",
    documentCreatedAtMs: nowMs,
    attachedToCase: true,
    caseClosedAtMs: nowMs,
  }), {
    allowed: false,
    code: "DOCUMENT_POLICY_RETENTION_CONTEXT_INVALID",
  });
});

test("legal hold overrides retention and Founder approval for every cleanup candidate", () => {
  assert.deepEqual(evaluateDocumentCleanupPolicy({
    retention: caseEvidenceRetention(),
    legalHold: true,
    founderApproved: true,
    nowMs: Date.UTC(2034, 0, 1),
  }), {
    allowed: false,
    code: "DOCUMENT_POLICY_LEGAL_HOLD",
  });
  assert.deepEqual(evaluateDocumentCleanupPolicy({
    retention: caseEvidenceRetention(),
    legalHold: false,
    founderApproved: false,
    nowMs: Date.UTC(2034, 0, 1),
  }), {
    allowed: false,
    code: "DOCUMENT_POLICY_FOUNDER_REQUIRED",
  });
});

test("export policy requires a Founder, healthy HK storage, watermark, and bounded expiry", () => {
  const base = {
    actor: founder(),
    retention: caseEvidenceRetention(),
    documentStorageRegion: DOCUMENT_OBJECT_REGION,
    hkRegionHealthy: true,
    nowMs,
    expiresAtMs: nowMs + DOCUMENT_EXPORT_MAX_TTL_MS,
    watermarkRequired: true,
  } as const;
  assert.equal(evaluateDocumentExportPolicy(base).allowed, true);
  assert.deepEqual(evaluateDocumentExportPolicy({ ...base, actor: founder(false) }), {
    allowed: false,
    code: "DOCUMENT_POLICY_FOUNDER_REQUIRED",
  });
  assert.deepEqual(evaluateDocumentExportPolicy({ ...base, hkRegionHealthy: false }), {
    allowed: false,
    code: "DOCUMENT_POLICY_HK_UNAVAILABLE",
  });
  assert.deepEqual(evaluateDocumentExportPolicy({ ...base, watermarkRequired: false }), {
    allowed: false,
    code: "DOCUMENT_POLICY_WATERMARK_REQUIRED",
  });
  assert.deepEqual(evaluateDocumentExportPolicy({
    ...base,
    expiresAtMs: nowMs + DOCUMENT_EXPORT_MAX_TTL_MS + 1,
  }), {
    allowed: false,
    code: "DOCUMENT_POLICY_EXPORT_TTL_INVALID",
  });
});

test("Founder legal hold transitions produce a receipt and reject non-Founder mutation", async () => {
  const result = await service().mutateLegalHold({
    actor: founder(),
    caseId: ids.case,
    documentId: ids.document,
    command: {
      action: "place",
      reason: "Pending legal review",
      expectedRecordVersion: 3,
      requestId: "document-hold-1",
      idempotencyKey: "document-hold-key-1",
    },
  });
  assert.equal(result.legalHold, true);
  assert.equal(result.receipt.auditEventId, ids.audit);

  await assert.rejects(
    () => service().mutateLegalHold({
      actor: founder(false),
      caseId: ids.case,
      documentId: ids.document,
      command: {
        action: "release",
        reason: "Not authorized",
        expectedRecordVersion: 4,
        requestId: "document-hold-2",
        idempotencyKey: "document-hold-key-2",
      },
    }),
    (error: unknown) => error instanceof DocumentPolicyError && error.code === "DOCUMENT_POLICY_FOUNDER_REQUIRED",
  );
});

test("export grants are constrained to one private HK use and receipt evidence", async () => {
  const exportGrant = await service().createExportGrant({
    actor: founder(),
    caseId: ids.case,
    documentId: ids.document,
    command: {
      expectedRecordVersion: 3,
      requestId: "document-export-1",
      idempotencyKey: "document-export-key-1",
      expiresAtMs: nowMs + 60_000,
    },
    policy: {
      retention: caseEvidenceRetention(),
      documentStorageRegion: DOCUMENT_OBJECT_REGION,
      hkRegionHealthy: true,
      watermarkRequired: true,
    },
  });
  assert.equal(exportGrant.remainingUses, 1);
  assert.equal(exportGrant.storageRegion, DOCUMENT_OBJECT_REGION);
  assert.equal(exportGrant.watermarkRequired, true);

  const download = await service().consumeExportGrant({
    actor: founder(),
    command: { exportId: exportGrant.exportId, requestId: "document-export-download-1" },
  });
  assert.match(download.location, /^https:\/\//);
  assert.equal(download.watermarkRequired, true);
});

test("policy runtime has no local or cross-region fallback", () => {
  assert.throws(
    () => getFailClosedPolicyRuntime(),
    DocumentPolicyRuntimeUnavailable,
  );
});
