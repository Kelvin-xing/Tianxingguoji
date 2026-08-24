import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  verifyOrderedMigrationManifest,
  type MigrationManifest,
} from "./migration-manifest.ts";

export const ONE_ROLE_BASELINE_ID = "tianxing-one-role-v1" as const;
export const ONE_ROLE_TRANSFORM_VERSION = "one-role-transform-v3" as const;
export const ONE_ROLE_CANONICAL_ROLE = "tianxing_app" as const;
export const ONE_ROLE_SOURCE_COUNT = 34;
export const ONE_ROLE_SOURCE_MANIFEST_SHA256 =
  "4ff9edfc846f9373bacce95a8fd27bc042921dc7b26e624716b14980d4ce86a1";
export const ONE_ROLE_BASELINE_DIRECTORY = "db/baselines/one-role";
export const ONE_ROLE_GENERATED_DIRECTORY = `${ONE_ROLE_BASELINE_DIRECTORY}/generated`;
export const ONE_ROLE_MANIFEST_PATH = `${ONE_ROLE_BASELINE_DIRECTORY}/manifest.json`;
export const ONE_ROLE_MARKER_SCHEMA = "tianxing_baseline" as const;
export const ONE_ROLE_MARKER_TABLE = "installations" as const;

const SOURCE_DIRECTORY = "db/migrations";
const SOURCE_MANIFEST_PATH = "db/migrations/manifest.json";
const HARDENING_FILE = "999_one_role_hardening.sql";

export const ONE_ROLE_TRANSFORM_SOURCES = Object.freeze({
  "202608030030_008_expand_application_database_role.sql":
    "7897a575374753aa94a7e946116fbb043758d91ee9e296cb9993ce1f7ead580d",
  "202608130010_011_expand_external_portal_access.sql":
    "79ce9dc99de2e947e68970f9cf4a2a0d4917bfd21f5868c052b25050f5251a1a",
  "202608130020_012_expand_platform_billing.sql":
    "a8c81b0674d5083b558d11aab8f528f486593ce7e125d2e937d61fc5a9727fb2",
  "202608130030_013_expand_case_billing_projection.sql":
    "3eaeb84dfe9a8436e1c98c4cecf49359abf2cd06ebd95ebc765a5e204b41fe76",
  "202608180090_025_harden_case_stage_transition.sql":
    "93a22834efb861714d2cdff965a9d5feb8f3e152d7c5e0f810050fb13671dcf5",
  "202608180120_028_expand_database_test_identity.sql":
    "a03e584fac57648abdc4049dbd05e00c35d2ec1a3fc3b06297b4b757574332bb",
} as const);

const LEGACY_DATABASE_ROLE_IDENTIFIERS = Object.freeze([
  "portal_auth",
  "platform_billing",
  "platform_billing_reader",
  "tianxing_test_application",
  "tianxing_test_identity",
  "tianxing_test_provisioner",
  "rds_iam",
] as const);

export type OneRoleTransformName =
  | "copy-v1"
  | "application-role-v1"
  | "external-portal-v1"
  | "platform-billing-v1"
  | "case-billing-projection-v1"
  | "case-stage-trigger-bootstrap-v1"
  | "database-test-identity-v1"
  | "hardening-v2";

export type OneRoleGeneratedFile = Readonly<{
  name: string;
  sha256: string;
  contents: string;
}>;

export type OneRoleBaselineManifest = Readonly<{
  baseline_version: 1;
  baseline_id: typeof ONE_ROLE_BASELINE_ID;
  status: "executable-unapplied";
  transform_version: typeof ONE_ROLE_TRANSFORM_VERSION;
  canonical_login_role: typeof ONE_ROLE_CANONICAL_ROLE;
  source_history_manifest: typeof SOURCE_MANIFEST_PATH;
  source_history_manifest_sha256: string;
  transaction_contract: Readonly<{
    single_transaction: true;
    advisory_lock: "transaction-scoped";
    dry_run: "rollback";
    apply: "commit";
  }>;
  marker: Readonly<{
    schema: typeof ONE_ROLE_MARKER_SCHEMA;
    table: typeof ONE_ROLE_MARKER_TABLE;
  }>;
  source_migrations: readonly Readonly<{
    name: string;
    source_sha256: string;
    generated_file: string;
    generated_sha256: string;
    transform: OneRoleTransformName;
  }>[];
  generated_files: readonly Readonly<{
    name: string;
    sha256: string;
    transform: OneRoleTransformName;
  }>[];
}>;

export type OneRoleBaselineBuild = Readonly<{
  manifest: OneRoleBaselineManifest;
  manifestJson: string;
  files: readonly OneRoleGeneratedFile[];
}>;

export class OneRoleBaselineGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OneRoleBaselineGenerationError";
  }
}

export async function buildOneRoleBaseline(input: Readonly<{
  sourceDirectory?: string;
  sourceManifestPath?: string;
}> = {}): Promise<OneRoleBaselineBuild> {
  const sourceDirectory = input.sourceDirectory ?? SOURCE_DIRECTORY;
  const sourceManifestPath = input.sourceManifestPath ?? SOURCE_MANIFEST_PATH;
  const history = await verifySourceHistory(sourceDirectory, sourceManifestPath);
  const sourceMigrations: OneRoleBaselineManifest["source_migrations"][number][] = [];
  const generatedFiles: OneRoleGeneratedFile[] = [];
  const generatedManifestFiles: OneRoleBaselineManifest["generated_files"][number][] = [];

  for (const [index, migration] of history.migrations.entries()) {
    const source = await readFile(resolve(sourceDirectory, migration.name), "utf8");
    const transformed = transformMigration(migration.name, migration.sha256, source);
    assertGeneratedSqlSafety(migration.name, transformed.sql);
    const generatedName = `${String(index + 1).padStart(3, "0")}_${migration.name}`;
    const generatedSha256 = sha256(transformed.sql);
    generatedFiles.push(Object.freeze({
      name: generatedName,
      sha256: generatedSha256,
      contents: transformed.sql,
    }));
    sourceMigrations.push(Object.freeze({
      name: migration.name,
      source_sha256: migration.sha256,
      generated_file: generatedName,
      generated_sha256: generatedSha256,
      transform: transformed.transform,
    }));
    generatedManifestFiles.push(Object.freeze({
      name: generatedName,
      sha256: generatedSha256,
      transform: transformed.transform,
    }));
  }

  const hardening = createHardeningSql();
  const hardeningSha256 = sha256(hardening);
  generatedFiles.push(Object.freeze({
    name: HARDENING_FILE,
    sha256: hardeningSha256,
    contents: hardening,
  }));
  generatedManifestFiles.push(Object.freeze({
    name: HARDENING_FILE,
    sha256: hardeningSha256,
    transform: "hardening-v2",
  }));

  const manifest = Object.freeze({
    baseline_version: 1 as const,
    baseline_id: ONE_ROLE_BASELINE_ID,
    status: "executable-unapplied" as const,
    transform_version: ONE_ROLE_TRANSFORM_VERSION,
    canonical_login_role: ONE_ROLE_CANONICAL_ROLE,
    source_history_manifest: SOURCE_MANIFEST_PATH,
    source_history_manifest_sha256: history.manifestSha256,
    transaction_contract: Object.freeze({
      single_transaction: true as const,
      advisory_lock: "transaction-scoped" as const,
      dry_run: "rollback" as const,
      apply: "commit" as const,
    }),
    marker: Object.freeze({
      schema: ONE_ROLE_MARKER_SCHEMA,
      table: ONE_ROLE_MARKER_TABLE,
    }),
    source_migrations: Object.freeze(sourceMigrations),
    generated_files: Object.freeze(generatedManifestFiles),
  });
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
  return Object.freeze({
    manifest,
    manifestJson,
    files: Object.freeze(generatedFiles),
  });
}

export async function writeOneRoleBaseline(): Promise<OneRoleBaselineBuild> {
  const build = await buildOneRoleBaseline();
  await mkdir(ONE_ROLE_GENERATED_DIRECTORY, { recursive: true });
  await Promise.all(build.files.map((file) =>
    writeFile(resolve(ONE_ROLE_GENERATED_DIRECTORY, file.name), file.contents, "utf8")
  ));
  await writeFile(ONE_ROLE_MANIFEST_PATH, build.manifestJson, "utf8");
  return build;
}

export async function verifyCommittedOneRoleBaseline(): Promise<OneRoleBaselineBuild> {
  const build = await buildOneRoleBaseline();
  const [manifestJson, entries] = await Promise.all([
    readFile(ONE_ROLE_MANIFEST_PATH, "utf8"),
    readdir(ONE_ROLE_GENERATED_DIRECTORY, { withFileTypes: true }),
  ]).catch(() => {
    throw new OneRoleBaselineGenerationError("Committed one-role baseline files could not be read.");
  });
  if (manifestJson !== build.manifestJson) {
    throw new OneRoleBaselineGenerationError("Committed one-role baseline manifest has drifted.");
  }
  const actualNames = entries.filter((entry) => entry.isFile()).map(({ name }) => name).sort();
  const expectedNames = build.files.map(({ name }) => name).sort();
  if (
    actualNames.length !== expectedNames.length ||
    actualNames.some((name, index) => name !== expectedNames[index])
  ) {
    throw new OneRoleBaselineGenerationError("Committed one-role generated file set has drifted.");
  }
  await Promise.all(build.files.map(async (expected) => {
    const actual = await readFile(resolve(ONE_ROLE_GENERATED_DIRECTORY, expected.name), "utf8");
    if (actual !== expected.contents || sha256(actual) !== expected.sha256) {
      throw new OneRoleBaselineGenerationError(
        `Committed one-role generated file has drifted: ${expected.name}`,
      );
    }
  }));
  return build;
}

async function verifySourceHistory(
  sourceDirectory: string,
  sourceManifestPath: string,
): Promise<MigrationManifest> {
  let manifest: MigrationManifest;
  try {
    manifest = await verifyOrderedMigrationManifest(sourceDirectory, sourceManifestPath);
  } catch (error) {
    throw new OneRoleBaselineGenerationError(
      error instanceof Error ? error.message : "Source migration verification failed.",
    );
  }
  if (
    manifest.migrations.length !== ONE_ROLE_SOURCE_COUNT ||
    manifest.manifestSha256 !== ONE_ROLE_SOURCE_MANIFEST_SHA256
  ) {
    throw new OneRoleBaselineGenerationError(
      `One-role baseline requires the frozen ${ONE_ROLE_SOURCE_COUNT}-source manifest.`,
    );
  }
  return manifest;
}

function transformMigration(
  name: string,
  sourceSha256: string,
  source: string,
): Readonly<{ transform: OneRoleTransformName; sql: string }> {
  const expectedTransformHash = ONE_ROLE_TRANSFORM_SOURCES[
    name as keyof typeof ONE_ROLE_TRANSFORM_SOURCES
  ];
  if (expectedTransformHash !== undefined && sourceSha256 !== expectedTransformHash) {
    throw new OneRoleBaselineGenerationError(`Transform source hash mismatch: ${name}`);
  }
  if (sha256(source) !== sourceSha256) {
    throw new OneRoleBaselineGenerationError(`Transform source content mismatch: ${name}`);
  }
  return transformOneRoleMigrationWithVerifiedHash(name, source);
}

export function assertOneRoleTransformAnchors(name: string, source: string): void {
  if (!(name in ONE_ROLE_TRANSFORM_SOURCES)) {
    throw new OneRoleBaselineGenerationError(`No explicit one-role transform exists for: ${name}`);
  }
  transformOneRoleMigrationWithVerifiedHash(name, source);
}

function transformOneRoleMigrationWithVerifiedHash(
  name: string,
  source: string,
): Readonly<{ transform: OneRoleTransformName; sql: string }> {
  switch (name) {
    case "202608030030_008_expand_application_database_role.sql":
      return Object.freeze({ transform: "application-role-v1", sql: transform008(source) });
    case "202608130010_011_expand_external_portal_access.sql":
      return Object.freeze({ transform: "external-portal-v1", sql: transform011(source) });
    case "202608130020_012_expand_platform_billing.sql":
      return Object.freeze({ transform: "platform-billing-v1", sql: transform012(source) });
    case "202608130030_013_expand_case_billing_projection.sql":
      return Object.freeze({ transform: "case-billing-projection-v1", sql: transform013(source) });
    case "202608180090_025_harden_case_stage_transition.sql":
      return Object.freeze({
        transform: "case-stage-trigger-bootstrap-v1",
        sql: transform025(source),
      });
    case "202608180120_028_expand_database_test_identity.sql":
      return Object.freeze({ transform: "database-test-identity-v1", sql: transform028(source) });
    default:
      return Object.freeze({ transform: "copy-v1", sql: source });
  }
}

function transform008(source: string): string {
  return replaceSpanOnce(
    source,
    "DO $$\nBEGIN\n  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tianxing_app') THEN",
    "GRANT rds_iam TO tianxing_app;\n",
    "-- one-role baseline: tianxing_app already exists as the database owner.\n",
    "008 role bootstrap",
  );
}

function transform011(source: string): string {
  let sql = replaceSpanOnce(
    source,
    "DO $$\nBEGIN\n  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'portal_auth') THEN",
    "ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM portal_auth;\n",
    [
      "-- one-role baseline: Portal discovery uses the canonical login and a protected function.",
      "REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;",
      "ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;",
      "",
    ].join("\n"),
    "011 portal role block",
  );
  sql = replaceExactOnce(
    sql,
    "GRANT EXECUTE ON FUNCTION portal_discover_grant_by_keyed_hash(bytea) TO portal_auth;",
    "GRANT EXECUTE ON FUNCTION portal_discover_grant_by_keyed_hash(bytea) TO tianxing_app;",
    "011 portal discovery grant",
  );
  return sql;
}

function transform012(source: string): string {
  let sql = replaceBetweenOnce(
    source,
    "DO $$\nBEGIN\n  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_billing') THEN",
    "CREATE TABLE platform_billing_actors (",
    "-- one-role baseline: database identities are unified; business roles remain row data.\n\n",
    "012 database role preamble",
  );
  sql = replaceBetweenOnce(
    sql,
    "CREATE POLICY platform_actor_self ON platform_billing_actors TO platform_billing",
    "REVOKE ALL ON ALL TABLES IN SCHEMA public FROM platform_billing;",
    platformBillingPolicies(),
    "012 writer and aggregate-reader policies",
  );
  sql = replaceFromOnce(
    sql,
    "REVOKE ALL ON ALL TABLES IN SCHEMA public FROM platform_billing;",
    platformBillingGrants(),
    "012 database role grants",
  );
  return sql;
}

function transform013(source: string): string {
  let sql = replaceSpanOnce(
    source,
    "CREATE POLICY cases_billing_projection_platform_read ON cases_billing_projection_events",
    "  USING (platform_billing_assert_actor()) WITH CHECK (platform_billing_assert_actor());\n",
    [
      "CREATE POLICY cases_billing_projection_platform_read ON cases_billing_projection_events",
      "  FOR SELECT TO tianxing_app",
      "  USING (current_setting('app.platform_billing_access_mode', true) = 'writer'",
      "    AND platform_billing_assert_actor());",
      "CREATE POLICY platform_billing_checkpoint_control ON platform_billing_projection_checkpoints",
      "  FOR ALL TO tianxing_app",
      "  USING (current_setting('app.platform_billing_access_mode', true) = 'writer'",
      "    AND platform_billing_assert_actor())",
      "  WITH CHECK (current_setting('app.platform_billing_access_mode', true) = 'writer'",
      "    AND platform_billing_assert_actor());",
      "",
    ].join("\n"),
    "013 platform policy block",
  );
  sql = replaceExactOnce(
    sql,
    "GRANT SELECT ON cases_billing_projection_events TO platform_billing;",
    "GRANT SELECT ON cases_billing_projection_events TO tianxing_app;",
    "013 platform event grant",
  );
  sql = replaceExactOnce(
    sql,
    "GRANT SELECT, INSERT, UPDATE ON platform_billing_projection_checkpoints TO platform_billing;",
    "GRANT SELECT, INSERT, UPDATE ON platform_billing_projection_checkpoints TO tianxing_app;",
    "013 platform checkpoint grant",
  );
  return sql;
}

function transform025(source: string): string {
  const trigger = [
    "CREATE TRIGGER cases_service_case_transition_facts_insert_guard_trg",
    "BEFORE INSERT ON cases_service_case_transition_facts",
    "FOR EACH ROW EXECUTE FUNCTION cases_validate_service_case_transition_fact_insert();",
  ].join("\n");
  return replaceExactOnce(
    source,
    trigger,
    [
      "GRANT TRIGGER ON TABLE public.cases_service_case_transition_facts TO tianxing_app;",
      trigger,
      "REVOKE TRIGGER ON TABLE public.cases_service_case_transition_facts FROM tianxing_app;",
    ].join("\n"),
    "025 transition fact trigger privilege window",
  );
}

function transform028(source: string): string {
  let sql = replaceBetweenOnce(
    source,
    "DO $$\nBEGIN\n  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tianxing_test_application') THEN",
    "CREATE TABLE identity_database_test_credentials (",
    [
      "-- one-role baseline: database-test application, identity, and provisioning paths",
      "-- use protected functions owned and invoked by tianxing_app.",
      "",
    ].join("\n"),
    "028 test role preamble",
  );
  sql = replaceFromOnce(
    sql,
    "REVOKE ALL ON TABLE identity_database_test_credentials FROM PUBLIC;",
    databaseTestIdentityGrants(),
    "028 credential and function grants",
  );
  return sql;
}

function platformBillingPolicies(): string {
  const writer = "current_setting('app.platform_billing_access_mode', true) = 'writer'";
  const reader = "current_setting('app.platform_billing_access_mode', true) = 'aggregate_reader'";
  return [
    "CREATE POLICY platform_actor_self ON platform_billing_actors TO tianxing_app",
    `  USING (${writer} AND id::text = current_setting('app.platform_actor_id', true));`,
    "CREATE POLICY platform_contract_control ON platform_billing_contract_versions TO tianxing_app",
    `  USING (${writer} AND platform_billing_assert_actor())`,
    `  WITH CHECK (${writer} AND platform_billing_assert_actor());`,
    "CREATE POLICY platform_metric_control ON platform_billing_metric_snapshots TO tianxing_app",
    `  USING (${writer} AND platform_billing_assert_actor())`,
    `  WITH CHECK (${writer} AND platform_billing_assert_actor());`,
    "CREATE POLICY platform_subscription_control ON platform_billing_subscription_projections TO tianxing_app",
    `  USING (${writer} AND platform_billing_assert_actor())`,
    `  WITH CHECK (${writer} AND platform_billing_assert_actor());`,
    "CREATE POLICY platform_audit_control ON platform_audit_events TO tianxing_app",
    `  USING (${writer} AND platform_billing_assert_actor())`,
    `  WITH CHECK (${writer} AND platform_billing_assert_actor());`,
    "CREATE POLICY platform_idempotency_control ON platform_billing_idempotency TO tianxing_app",
    `  USING (${writer} AND platform_billing_assert_actor())`,
    `  WITH CHECK (${writer} AND platform_billing_assert_actor());`,
    "",
    "CREATE POLICY platform_contract_aggregate_read ON platform_billing_contract_versions",
    `  FOR SELECT TO tianxing_app USING (${reader});`,
    "CREATE POLICY platform_metric_aggregate_read ON platform_billing_metric_snapshots",
    `  FOR SELECT TO tianxing_app USING (${reader});`,
    "CREATE POLICY platform_subscription_aggregate_read ON platform_billing_subscription_projections",
    `  FOR SELECT TO tianxing_app USING (${reader});`,
    "",
  ].join("\n");
}

function platformBillingGrants(): string {
  return [
    "REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;",
    "REVOKE ALL ON FUNCTION platform_billing_assert_actor() FROM PUBLIC;",
    "REVOKE ALL ON FUNCTION platform_billing_reject_immutable() FROM PUBLIC;",
    "REVOKE ALL ON FUNCTION platform_billing_validate_contract_write() FROM PUBLIC;",
    "GRANT USAGE ON SCHEMA public TO tianxing_app;",
    "GRANT SELECT ON platform_billing_actors TO tianxing_app;",
    "GRANT SELECT, INSERT, UPDATE ON platform_billing_contract_versions TO tianxing_app;",
    "GRANT SELECT, INSERT ON platform_billing_metric_snapshots, platform_audit_events TO tianxing_app;",
    "GRANT SELECT, INSERT, UPDATE ON platform_billing_subscription_projections, platform_billing_idempotency TO tianxing_app;",
    "GRANT EXECUTE ON FUNCTION platform_billing_assert_actor() TO tianxing_app;",
    "",
  ].join("\n");
}

function databaseTestIdentityGrants(): string {
  return [
    "REVOKE ALL ON TABLE identity_database_test_credentials FROM PUBLIC;",
    "",
    "REVOKE ALL ON FUNCTION identity_validate_database_test_session_write() FROM PUBLIC;",
    "REVOKE ALL ON FUNCTION identity_database_test_lookup_credential(text) FROM PUBLIC;",
    "REVOKE ALL ON FUNCTION identity_database_test_complete_login(uuid, bigint, boolean, uuid, bytea, timestamptz) FROM PUBLIC;",
    "REVOKE ALL ON FUNCTION identity_database_test_resolve_session(bytea, timestamptz, boolean) FROM PUBLIC;",
    "REVOKE ALL ON FUNCTION identity_database_test_revoke_session(bytea, text) FROM PUBLIC;",
    "REVOKE ALL ON FUNCTION identity_database_test_lookup_provision_credential(text) FROM PUBLIC;",
    "REVOKE ALL ON FUNCTION identity_database_test_provision_credential(text, text, bytea, bytea, boolean) FROM PUBLIC;",
    "",
    "GRANT USAGE ON SCHEMA public TO tianxing_app;",
    "GRANT EXECUTE ON FUNCTION identity_database_test_lookup_credential(text) TO tianxing_app;",
    "GRANT EXECUTE ON FUNCTION identity_database_test_complete_login(uuid, bigint, boolean, uuid, bytea, timestamptz) TO tianxing_app;",
    "GRANT EXECUTE ON FUNCTION identity_database_test_resolve_session(bytea, timestamptz, boolean) TO tianxing_app;",
    "GRANT EXECUTE ON FUNCTION identity_database_test_revoke_session(bytea, text) TO tianxing_app;",
    "GRANT EXECUTE ON FUNCTION identity_database_test_lookup_provision_credential(text) TO tianxing_app;",
    "GRANT EXECUTE ON FUNCTION identity_database_test_provision_credential(text, text, bytea, bytea, boolean) TO tianxing_app;",
    "",
  ].join("\n");
}

function createHardeningSql(): string {
  return [
    "-- Generated one-role final hardening. Do not edit by hand.",
    "DO $one_role_hardening$",
    "DECLARE",
    "  target_table record;",
    "  target_function record;",
    "BEGIN",
    "  FOR target_table IN",
    "    SELECT namespace_row.nspname AS schema_name, class_row.relname AS relation_name",
    "      FROM pg_class AS class_row",
    "      JOIN pg_namespace AS namespace_row ON namespace_row.oid = class_row.relnamespace",
    "     WHERE namespace_row.nspname = 'public'",
    "       AND class_row.relkind IN ('r', 'p')",
    "       AND class_row.relrowsecurity",
    "     ORDER BY class_row.relname COLLATE \"C\"",
    "  LOOP",
    "    EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY',",
    "      target_table.schema_name, target_table.relation_name);",
    "  END LOOP;",
    "",
    "  FOR target_function IN",
    "    SELECT function_row.function_identity",
    "      FROM (",
    "        SELECT format('%I.%I(%s)', namespace_row.nspname, procedure_row.proname,",
    "                 pg_get_function_identity_arguments(procedure_row.oid)) AS function_identity",
    "          FROM pg_proc AS procedure_row",
    "          JOIN pg_namespace AS namespace_row ON namespace_row.oid = procedure_row.pronamespace",
    "         WHERE namespace_row.nspname = 'public'",
    "           AND procedure_row.prosecdef",
    "      ) AS function_row",
    "     ORDER BY function_row.function_identity COLLATE \"C\"",
    "  LOOP",
    "    EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, public',",
    "      target_function.function_identity);",
    "    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',",
    "      target_function.function_identity);",
    "    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO tianxing_app',",
    "      target_function.function_identity);",
    "  END LOOP;",
    "END;",
    "$one_role_hardening$;",
    "",
  ].join("\n");
}

function assertGeneratedSqlSafety(name: string, sql: string): void {
  if (/\b(?:CREATE|ALTER)\s+ROLE\b/i.test(sql) || /\bGRANT\s+rds_iam\b/i.test(sql)) {
    throw new OneRoleBaselineGenerationError(`Generated SQL contains database role DDL: ${name}`);
  }
  const tokens = new Set(sql.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []);
  for (const legacyRole of LEGACY_DATABASE_ROLE_IDENTIFIERS) {
    if (tokens.has(legacyRole)) {
      throw new OneRoleBaselineGenerationError(
        `Generated SQL contains legacy database role identifier ${legacyRole}: ${name}`,
      );
    }
  }
}

function replaceSpanOnce(
  source: string,
  start: string,
  inclusiveEnd: string,
  replacement: string,
  label: string,
): string {
  assertOccurrenceCount(source, start, 1, `${label} start`);
  assertOccurrenceCount(source, inclusiveEnd, 1, `${label} end`);
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(inclusiveEnd, startIndex) + inclusiveEnd.length;
  if (endIndex <= startIndex) throw new OneRoleBaselineGenerationError(`Invalid transform span: ${label}`);
  return `${source.slice(0, startIndex)}${replacement}${source.slice(endIndex)}`;
}

function replaceBetweenOnce(
  source: string,
  start: string,
  exclusiveEnd: string,
  replacement: string,
  label: string,
): string {
  assertOccurrenceCount(source, start, 1, `${label} start`);
  assertOccurrenceCount(source, exclusiveEnd, 1, `${label} end`);
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(exclusiveEnd, startIndex);
  if (endIndex <= startIndex) throw new OneRoleBaselineGenerationError(`Invalid transform span: ${label}`);
  return `${source.slice(0, startIndex)}${replacement}${source.slice(endIndex)}`;
}

function replaceFromOnce(source: string, start: string, replacement: string, label: string): string {
  assertOccurrenceCount(source, start, 1, label);
  return `${source.slice(0, source.indexOf(start))}${replacement}`;
}

function replaceExactOnce(source: string, search: string, replacement: string, label: string): string {
  assertOccurrenceCount(source, search, 1, label);
  return source.replace(search, replacement);
}

function assertOccurrenceCount(source: string, search: string, expected: number, label: string): void {
  let count = 0;
  let offset = 0;
  while ((offset = source.indexOf(search, offset)) !== -1) {
    count += 1;
    offset += search.length;
  }
  if (count !== expected) {
    throw new OneRoleBaselineGenerationError(
      `Transform anchor count mismatch for ${label}: expected ${expected}, found ${count}.`,
    );
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function runCli(arguments_: readonly string[]): Promise<void> {
  if (arguments_.length !== 1 || !["--write", "--check"].includes(arguments_[0] ?? "")) {
    throw new OneRoleBaselineGenerationError("Specify exactly one mode: --write or --check.");
  }
  const build = arguments_[0] === "--write"
    ? await writeOneRoleBaseline()
    : await verifyCommittedOneRoleBaseline();
  process.stdout.write(`${JSON.stringify({
    baseline_id: build.manifest.baseline_id,
    source_migrations: build.manifest.source_migrations.length,
    generated_files: build.manifest.generated_files.length,
    status: arguments_[0] === "--write" ? "generated" : "verified",
  })}\n`);
}

const isMainModule = process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  runCli(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "One-role baseline generation failed.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
