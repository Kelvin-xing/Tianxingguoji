import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("workspace school directory is isolated from the legacy crawler client", async () => {
  const client = await readFile(
    new URL("../../../modules/schools/client.ts", import.meta.url),
    "utf8",
  );
  const page = await readFile(
    new URL("../../../app/(erp)/schools/page.tsx", import.meta.url),
    "utf8",
  );

  assert.match(client, /infrastructure\/directory-client/);
  assert.doesNotMatch(client, /infrastructure\/crawler\/client/);
  assert.match(page, /listSchoolDirectory/);
  assert.doesNotMatch(page, /crawlerApi|api\/crawler/);
});

test("legacy crawler surfaces import their compatibility client explicitly", async () => {
  const adminCrawler = await readFile(
    new URL("../../../app/(erp)/admin/crawler/page.tsx", import.meta.url),
    "utf8",
  );
  const selector = await readFile(
    new URL("../../../app/(erp)/selector/page.tsx", import.meta.url),
    "utf8",
  );

  assert.match(adminCrawler, /modules\/schools\/crawler-client/);
  assert.match(selector, /modules\/schools\/crawler-client/);
});
