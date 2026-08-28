import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("database-test school fixture is fixed, Founder-only and idempotent", async () => {
  const source = await readFile(
    new URL(
      "../../../modules/schools/infrastructure/database-test-resolved-fixture.ts",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(source, /runtime\.appEnvironment !== "test"/);
  assert.match(source, /runtime\.appRuntimeMode !== "test-database"/);
  assert.match(source, /runtime\.authMode !== "database-test"/);
  assert.match(source, /runtime\.vercel === false/);
  assert.match(source, /!actor\.roles\.includes\("founder"\)/);
  assert.match(source, /actor\.organizationId !== NEON_TEST_ORGANIZATION\.id/);
  assert.match(source, /ON CONFLICT \(organization_id, school_id, resolution_sha256\) DO NOTHING/);
  assert.doesNotMatch(source, /DELETE FROM|UPDATE schools_|TRUNCATE/);
});

test("fixture route accepts no school payload and returns only fixed revision facts", async () => {
  const source = await readFile(
    new URL("../../../app/api/v1/test-fixtures/schools/route.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /export async function POST\(request: Request\)/);
  assert.match(source, /requireApiRequestAccessContext\(\)/);
  assert.match(source, /ensureDatabaseTestResolvedSchoolFixture/);
  assert.doesNotMatch(source, /request\.json\(|request\.text\(|searchParams/);
  assert.doesNotMatch(source, /export async function GET/);
});
