import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("create page contract uses JSON and the required idempotency header", () => {
  const source = readFileSync(
    resolve(process.cwd(), "app/(erp)/cases/reconstructions/new/page.tsx"),
    "utf8",
  );
  assert.ok(source.includes("idempotency-key"));
  assert.ok(source.includes("application/json"));
  assert.ok(source.includes("pilot_reference"));
  assert.equal(source.includes('method="post"'), false);
});
