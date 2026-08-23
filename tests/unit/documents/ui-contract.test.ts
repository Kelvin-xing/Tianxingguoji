import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../../", import.meta.url);

test("Document routes use authoritative components and Case detail mounts the panel", async () => {
  const [directoryPage, directory, casePage] = await Promise.all([
    source("app/(erp)/documents/page.tsx"),
    source("components/documents/DocumentsDirectory.tsx"),
    source("app/(erp)/cases/[caseId]/page.tsx"),
  ]);
  assert.match(directoryPage, /<DocumentsDirectory \/>/);
  assert.match(casePage, /<CaseDocumentsPanel caseId=\{caseId\} \/>/);
  assert.doesNotMatch(`${directoryPage}\n${directory}`, /previewCaseWorkspaceAdapter|Preview adapter|mock|fake|fetch\(/i);
});

test("Document UI is capability-only and exposes no upload or raw identifier controls", async () => {
  const [directory, panel, shared] = await Promise.all([
    source("components/documents/DocumentsDirectory.tsx"),
    source("components/documents/CaseDocumentsPanel.tsx"),
    source("components/documents/document-ui.tsx"),
  ]);
  assert.match(directory, /documents\.read/);
  assert.match(panel, /documents\.read/);
  assert.match(panel, /documents\.create/);
  assert.doesNotMatch(`${directory}\n${panel}`, /access\.role|snapshot\.role|capabilitiesByRole|ROLE_(?:CAPABILITIES|NAVIGATION)/);
  assert.doesNotMatch(`${directory}\n${panel}\n${shared}`, /type=["']file|drag|drop|checksum|mime|signed URL|presigned|raw UUID|localStorage|sessionStorage|console\./i);
  assert.doesNotMatch(directory, /upload|上載文件|Clean|preview/i);
});

test("Document registration uses a synchronous lock, exact attempt and authoritative detail plus list refresh", async () => {
  const panel = await source("components/documents/CaseDocumentsPanel.tsx");
  assert.match(panel, /if \(submitting\.current \|\| pending \|\| !canCreate\) return/);
  assert.match(panel, /attempt\.current!\.keyFor\(documentRegistrationFingerprint\(input\)\)/);
  assert.match(panel, /const detail = await getCaseDocument\(caseId, receipt\.id\)/);
  assert.match(panel, /detail\.document\.record_version !== receipt\.record_version/);
  assert.match(panel, /const authoritative = await listCaseDocuments\(caseId\)/);
  assert.match(panel, /created\.record_version !== receipt\.record_version/);
  assert.match(panel, /failure !== "unavailable"/);
});

test("Document states, fixed filters, accessibility and null-version language remain truthful", async () => {
  const [directory, panel, shared] = await Promise.all([
    source("components/documents/DocumentsDirectory.tsx"),
    source("components/documents/CaseDocumentsPanel.tsx"),
    source("components/documents/document-ui.tsx"),
  ]);
  for (const state of ["loading", "ready", "unauthenticated", "denied", "unavailable"]) assert.match(directory, new RegExp(`[\"]${state}[\"]`));
  for (const state of ["success", "validation", "conflict", "denied", "unavailable"]) assert.match(panel, new RegExp(`[\"]${state}[\"]`));
  assert.match(directory, /DOCUMENT_CLASSIFICATIONS/);
  assert.match(directory, /DOCUMENT_LIFECYCLE_STATES/);
  assert.match(directory, /DOCUMENT_VERSION_STATES/);
  assert.match(shared, /value === null\) return "等待上載"/);
  assert.doesNotMatch(shared, /null.*(?:clean|available)|清潔|安全可用/i);
  assert.match(panel, /required/);
  assert.match(panel, /aria-busy=\{pending\}/);
  assert.match(panel, /nameInput\.current\?\.focus\(\)/);
});

test("DOC-01 permanent browser source is isolated, privacy-safe and intentionally not a static substitute", async () => {
  const [browser, packageJson] = await Promise.all([
    source("tests/integration/doc-01-case-document-registration-read-dev-browser.test.ts"),
    source("package.json"),
  ]);
  assert.match(packageJson, /"test:doc-01-dev-browser": "node --conditions=react-server --test tests\/integration\/doc-01-case-document-registration-read-dev-browser\.test\.ts"/);
  for (const contract of [
    "postgres:17.10-alpine3.24",
    "verifyCommittedOneRoleBaseline",
    "seedNeonTestRelease1",
    "launchPersistentContext",
    "client_validation_zero_post",
    "uncertain_retry_same_key",
    "changed_command_new_key",
    "synchronous_double_post_count",
    "authoritative_detail_refresh",
    "directory_persistence",
    "relogin_persistence",
    "awaiting_upload_truthful",
    "denied_roles",
    "desktop_viewport",
    "mobile_viewport",
    "browser_log_safety",
  ]) assert.match(browser, new RegExp(contract));
  assert.match(browser, /horizontal_overflow/);
  assert.match(browser, /out_of_bounds_controls/);
  assert.match(browser, /overlapping_controls/);
  assert.match(browser, /clipped_text/);
  assert.match(browser, /cleanup\.container_removed/);
  assert.doesNotMatch(browser, /console\.(?:log|error)|context\.addCookies|localStorage|sessionStorage/);
});

async function source(path: string): Promise<string> {
  return readFile(new URL(path, root), "utf8");
}
