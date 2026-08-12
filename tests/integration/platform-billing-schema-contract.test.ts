import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const billingMigration = new URL("../../db/migrations/202608130020_012_expand_platform_billing.sql", import.meta.url);
const projectionMigration = new URL("../../db/migrations/202608130030_013_expand_case_billing_projection.sql", import.meta.url);

test("platform schema is aggregate-only, append-only, separately audited, and least privilege", async () => {
  const sql = await readFile(billingMigration, "utf8");
  assert.match(sql, /CREATE TABLE platform_billing_contract_versions/);
  assert.match(sql, /CREATE TABLE platform_billing_metric_snapshots/);
  assert.match(sql, /CREATE TABLE platform_audit_events/);
  assert.match(sql, /FORCE ROW LEVEL SECURITY/g);
  assert.match(sql, /platform_billing_reject_immutable/);
  assert.match(sql, /SECURITY INVOKER\s+SET search_path = pg_catalog, public/);
  assert.match(sql, /platform_audit_events_metadata_values_check/);
  assert.match(sql, /platform_billing_contract_state_transition/);
  assert.match(sql, /created_by_actor_id <> approved_by_actor_id/);
  assert.match(sql, /contract_value_minor >= 0/);
  assert.match(sql, /currency IN \('HKD', 'USD', 'CNY'\)/);
  assert.doesNotMatch(sql, /student_name|guardian|email|phone|address|subtotal_minor|tax_minor|total_minor/i);
  assert.match(sql, /REVOKE ALL ON ALL TABLES IN SCHEMA public FROM platform_billing/);
  assert.match(sql, /REVOKE ALL ON FUNCTION platform_billing_assert_actor\(\) FROM PUBLIC/);
  assert.doesNotMatch(sql, /GRANT[^;]*(cases_service_cases|crm_)/i);
});

test("billing writer and aggregate reader have distinct RDS IAM least-privilege roles", async () => {
  const sql = await readFile(billingMigration, "utf8");

  assert.match(sql, /CREATE ROLE platform_billing LOGIN[^;]*NOBYPASSRLS/);
  assert.match(sql, /CREATE ROLE platform_billing_reader LOGIN[^;]*NOBYPASSRLS/);
  assert.match(sql, /GRANT rds_iam TO platform_billing;/);
  assert.match(sql, /GRANT rds_iam TO platform_billing_reader;/);
  assert.match(sql, /GRANT CONNECT ON DATABASE %I TO platform_billing/);
  assert.match(sql, /GRANT CONNECT ON DATABASE %I TO platform_billing_reader/);
  assert.match(sql, /CREATE POLICY platform_contract_aggregate_read ON platform_billing_contract_versions\s+FOR SELECT TO platform_billing_reader USING \(true\);/s);
  assert.match(sql, /CREATE POLICY platform_metric_aggregate_read ON platform_billing_metric_snapshots\s+FOR SELECT TO platform_billing_reader USING \(true\);/s);
  assert.match(sql, /CREATE POLICY platform_subscription_aggregate_read ON platform_billing_subscription_projections\s+FOR SELECT TO platform_billing_reader USING \(true\);/s);
  assert.match(sql, /REVOKE ALL ON ALL TABLES IN SCHEMA public FROM platform_billing_reader/);
  assert.match(sql, /GRANT SELECT \([^;]+\)\s+ON platform_billing_contract_versions TO platform_billing_reader;/s);
  assert.match(sql, /GRANT SELECT \([^;]+\)\s+ON platform_billing_metric_snapshots TO platform_billing_reader;/s);
  assert.match(sql, /GRANT SELECT \([^;]+\)\s+ON platform_billing_subscription_projections TO platform_billing_reader;/s);
  assert.doesNotMatch(sql, /GRANT[^;]*(platform_audit_events|platform_billing_idempotency|platform_billing_actors)[^;]*TO platform_billing_reader/i);
  assert.doesNotMatch(sql, /GRANT[^;]*(cases_service_cases|cases_billing_projection_events|crm_)[^;]*TO platform_billing_reader/i);
  const readerGrants = sql
    .split(";")
    .filter((statement) => /GRANT[\s\S]*TO platform_billing_reader\s*$/i.test(statement));
  assert.ok(readerGrants.length > 0);
  for (const statement of readerGrants) {
    assert.doesNotMatch(statement, /\b(?:INSERT|UPDATE|DELETE)\b/i);
  }
});

test("Cases handoff stores only the six-field immutable projection and a checkpoint", async () => {
  const sql = await readFile(projectionMigration, "utf8");
  assert.match(sql, /CREATE TABLE cases_billing_projection_events/);
  assert.match(sql, /event_id text NOT NULL/);
  assert.match(sql, /organization_id uuid NOT NULL/);
  assert.match(sql, /case_id uuid NOT NULL/);
  assert.match(sql, /stage text NOT NULL/);
  assert.match(sql, /effective_at timestamptz NOT NULL/);
  assert.match(sql, /case_version integer NOT NULL/);
  assert.match(sql, /cases_billing_projection_reject_mutation/);
  assert.match(sql, /REVOKE ALL ON FUNCTION cases_billing_projection_reject_mutation\(\) FROM PUBLIC/);
  assert.match(sql, /CREATE TABLE platform_billing_projection_checkpoints/);
  assert.doesNotMatch(sql, /student|guardian|email|phone|address|jsonb/i);
  assert.doesNotMatch(sql, /014_enable_multiple_active_organizations|DROP INDEX[^;]*access_organizations_one_active_idx/i);
});
