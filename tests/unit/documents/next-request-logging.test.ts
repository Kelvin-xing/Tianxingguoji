import assert from "node:assert/strict";
import test from "node:test";

import nextConfig, {
  DOCUMENT_TRANSFER_PRIVATE_REQUEST_PATTERNS,
} from "../../../next.config.ts";

const CASE_ID = "81000000-0000-4000-8000-000000000001";
const DOCUMENT_ID = "81000000-0000-4000-8000-000000000002";
const VERSION_ID = "81000000-0000-4000-8000-000000000003";
const VERSION_PATH = `/api/v1/cases/${CASE_ID}/documents/${DOCUMENT_ID}/versions/${VERSION_ID}`;

test("Next suppresses only exact Document version transfer request logs", () => {
  assert.deepEqual(
    nextConfig.logging,
    { incomingRequests: { ignore: [...DOCUMENT_TRANSFER_PRIVATE_REQUEST_PATTERNS] } },
  );
  assert.equal(DOCUMENT_TRANSFER_PRIVATE_REQUEST_PATTERNS.length, 2);

  for (const sensitivePath of [
    `${VERSION_PATH}/upload-intents`,
    `${VERSION_PATH}/upload-intents?fixed=1`,
    `${VERSION_PATH}/abandonments`,
    `${VERSION_PATH}/abandonments?fixed=1`,
  ]) {
    assert.equal(matchesIgnore(sensitivePath), true);
  }

  for (const retainedPath of [
    `${VERSION_PATH}/download-intents`,
    `${VERSION_PATH}/upload-intents/extra`,
    `${VERSION_PATH}/abandonments/extra`,
    `/api/v1/cases/${CASE_ID}/documents/${DOCUMENT_ID}/versions`,
    `/api/v1/cases/${CASE_ID}/documents/${DOCUMENT_ID}`,
    `/api/v1/cases/not-a-uuid/documents/${DOCUMENT_ID}/versions/${VERSION_ID}/upload-intents`,
    `/documents/${DOCUMENT_ID}/versions/${VERSION_ID}/upload-intents`,
  ]) {
    assert.equal(matchesIgnore(retainedPath), false);
  }
});

function matchesIgnore(value: string): boolean {
  return DOCUMENT_TRANSFER_PRIVATE_REQUEST_PATTERNS.some((pattern) => pattern.test(value));
}
