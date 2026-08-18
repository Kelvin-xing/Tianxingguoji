import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationPath = "db/migrations/202608180060_022_expose_bound_assessment_manifest.sql";
const answerValidationMigrationPath =
  "db/migrations/202608180070_023_harden_assessment_answer_validation.sql";

test("exposes only organization-bound assessment manifest reads to the application role", async () => {
  const sql = await readFile(migrationPath, "utf8");

  assert.match(sql, /CREATE FUNCTION cases_read_bound_assessment_manifest\(target_manifest_id uuid\)/);
  assert.match(sql, /CREATE FUNCTION cases_read_bound_assessment_manifest_fields\(target_manifest_id uuid\)/);
  assert.match(sql, /SECURITY DEFINER/g);
  assert.match(sql, /current_setting\('app\.organization_id', true\)/g);
  assert.match(sql, /REVOKE ALL ON FUNCTION cases_read_bound_assessment_manifest\(uuid\) FROM PUBLIC/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION cases_read_bound_assessment_manifest_fields\(uuid\) TO tianxing_app/);
  assert.doesNotMatch(
    sql,
    /GRANT SELECT ON (?:cases_schema_manifests|cases_schema_manifest_fields) TO tianxing_app/,
  );
});

test("maps runtime assessment statuses to the stored blocker names", async () => {
  const sql = await readFile(migrationPath, "utf8");

  assert.match(sql, /OLD\.status = 'draft' AND NEW\.status = 'background_complete'/);
  assert.match(sql, /blocker_stage := 'background_complete'/);
  assert.match(sql, /OLD\.status = 'background_complete' AND NEW\.status = 'selection_ready'/);
  assert.match(sql, /blocker_stage := 'selection_ready'/);
  assert.match(sql, /field\.blocking_stages \? blocker_stage/);
  assert.match(sql, /cases_assessments_runtime_blockers_incomplete_check/);
});

test("runs assessment answer contract validation without granting manifest table reads", async () => {
  const sql = await readFile(answerValidationMigrationPath, "utf8");

  assert.match(sql, /ALTER FUNCTION cases_validate_answer_write\(\) SECURITY DEFINER/);
  assert.match(
    sql,
    /ALTER FUNCTION cases_validate_answer_write\(\) SET search_path = pg_catalog, public/,
  );
  assert.match(sql, /REVOKE ALL ON FUNCTION cases_validate_answer_write\(\) FROM PUBLIC/);
  assert.doesNotMatch(sql, /GRANT (?:SELECT|ALL) ON/);
});
