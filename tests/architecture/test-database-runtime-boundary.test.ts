import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const APPROVED_RUNTIMES = Object.freeze([
  "modules/cases/infrastructure/runtime.ts",
  "modules/cases/infrastructure/school-target-runtime.ts",
  "modules/cases/infrastructure/transition-runtime.ts",
  "modules/crm/infrastructure/runtime.ts",
]);

const APPROVED_ROUTES = Object.freeze([
  "app/api/v1/cases/[caseId]/assessment/background-completion/route.ts",
  "app/api/v1/cases/[caseId]/assessment/route.ts",
  "app/api/v1/cases/[caseId]/route.ts",
  "app/api/v1/cases/[caseId]/school-targets/route.ts",
  "app/api/v1/cases/[caseId]/transitions/route.ts",
  "app/api/v1/cases/options/route.ts",
  "app/api/v1/cases/route.ts",
  "app/api/v1/students/[studentId]/route.ts",
  "app/api/v1/students/route.ts",
]);

test("enables test-database composition only for the four approved runtimes", async () => {
  const actual = await filesUnder("modules").then(async (files) => {
    const matches = await Promise.all(files.map(async (file) =>
      (await readFile(file, "utf8")).includes("getApplicationTenantRunner") ? file : null));
    return matches.filter((file): file is string => file !== null &&
      file !== "modules/shared/infrastructure/application-postgresql.ts").sort();
  });
  assert.deepEqual(actual, APPROVED_RUNTIMES);
});

test("freezes the nine API v1 routes composed by those runtimes", async () => {
  const runtimePattern = /get(?:StudentRead|CaseWorkspace|CaseTransition|SchoolTarget)Runtime/;
  const actual = await filesUnder("app/api/v1").then(async (files) => {
    const matches = await Promise.all(files.map(async (file) =>
      runtimePattern.test(await readFile(file, "utf8")) ? file : null));
    return matches.filter((file): file is string => file !== null).sort();
  });
  assert.deepEqual(actual, APPROVED_ROUTES);
});

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  }));
  return files.flat().filter((file) => /\.(?:ts|tsx)$/.test(file));
}
