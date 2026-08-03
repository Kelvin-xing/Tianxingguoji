import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("TypeScript permits the .ts imports used by P0 modules", async () => {
  const config = JSON.parse(
    await readFile(new URL("../../tsconfig.json", import.meta.url), "utf8"),
  ) as {
    compilerOptions?: {
      allowImportingTsExtensions?: boolean;
      noEmit?: boolean;
    };
  };

  assert.equal(config.compilerOptions?.noEmit, true);
  assert.equal(config.compilerOptions?.allowImportingTsExtensions, true);
});
