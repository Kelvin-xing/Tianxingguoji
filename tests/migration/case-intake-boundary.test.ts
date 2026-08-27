import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("D5 signed_at corrective migration preserves nullable historical rows and adds no entity", async () => {
  const sql = await readFile("db/migrations/202608260110_047_add_case_signed_at.sql", "utf8");
  assert.match(sql, /ALTER TABLE cases_service_cases\s+ADD COLUMN signed_at timestamptz/i);
  assert.doesNotMatch(sql, /signed_at timestamptz NOT NULL/i);
  assert.doesNotMatch(sql, /CREATE TABLE/i);
  assert.doesNotMatch(sql, /DROP COLUMN|DROP TABLE|DELETE FROM/i);
});

test("D5 source and route boundaries keep manifest server-owned", async () => {
  const [route, repository, crmOwner, accessOwner, routeContract] = await Promise.all([
    readFile("app/api/v1/cases/route.ts", "utf8"),
    readFile("modules/cases/infrastructure/postgresql-case-intake-repository.ts", "utf8"),
    readFile("modules/crm/infrastructure/postgresql-case-intake-owner.ts", "utf8"),
    readFile("modules/access/infrastructure/postgresql-case-intake-owner.ts", "utf8"),
    readFile("app/api/v1/cases/intake-route-contract.ts", "utf8"),
  ]);
  assert.match(route, /parseCaseIntakeRequest/);
  assert.doesNotMatch(route, /manifest_id|manifestId/);
  assert.doesNotMatch(repository, /crm_students|crm_referral_sources|access_role_bindings|identity_users/);
  assert.match(repository, /cases_schema_manifests/);
  assert.match(repository, /runIdempotentTransaction/);
  assert.match(repository, /cases\.create_k12_case/);
  assert.match(crmOwner, /organization_id=\$1/);
  assert.match(accessOwner, /organization_id=\$1/);
  assert.match(crmOwner, /status='active'/);
  assert.match(accessOwner, /binding\.role='advisor'/);
  assert.doesNotMatch(crmOwner, /modules\/cases\/(?:application|infrastructure)/);
  assert.doesNotMatch(accessOwner, /modules\/cases\/(?:application|infrastructure)/);
  assert.match(routeContract, /modules\/cases\/public\.ts/);
  assert.doesNotMatch(routeContract, /modules\/cases\/(?:server|application)\.ts/);
});
