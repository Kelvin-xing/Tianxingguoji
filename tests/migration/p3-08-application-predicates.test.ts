import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationPath = "db/migrations/202608130040_016_expand_application_predicates.sql";

test("P3-08 application predicates expose only narrow boolean authority checks", async () => {
  const sql = await readFile(migrationPath, "utf8");
  for (const predicate of [
    "identity_user_is_active",
    "access_organization_is_active",
    "cases_manifest_is_approved",
  ]) {
    assert.match(sql, new RegExp(`CREATE FUNCTION ${predicate}\\(target_[a-z_]+ uuid\\)`));
    assert.match(sql, new RegExp(`REVOKE ALL ON FUNCTION ${predicate}\\(uuid\\) FROM PUBLIC`));
    assert.match(sql, new RegExp(`GRANT EXECUTE ON FUNCTION ${predicate}\\(uuid\\) TO tianxing_app`));
  }
  assert.equal((sql.match(/SECURITY DEFINER/g) ?? []).length, 5);
  assert.equal((sql.match(/SET search_path = pg_catalog, public/g) ?? []).length, 5);
  assert.doesNotMatch(sql, /GRANT SELECT ON (?:identity_users|access_organizations|cases_schema_manifests)/);
});

test("P3-08 Case trigger privilege is bounded and not callable by PUBLIC", async () => {
  const sql = await readFile(migrationPath, "utf8");
  for (const triggerFunction of [
    "cases_validate_service_case_write",
    "cases_validate_assessment_write",
  ]) {
    assert.match(sql, new RegExp(`ALTER FUNCTION ${triggerFunction}\\(\\) SECURITY DEFINER`));
    assert.match(sql, new RegExp(`ALTER FUNCTION ${triggerFunction}\\(\\) SET search_path = pg_catalog, public`));
    assert.match(sql, new RegExp(`REVOKE ALL ON FUNCTION ${triggerFunction}\\(\\) FROM PUBLIC`));
  }
});
