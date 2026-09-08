import { readFile } from "node:fs/promises";

import { Client } from "pg";

const EXPECTED_APPLICATION_USER = "tianxing_app";
const MIGRATION_LOCK_ID = 570_908_001;
const MIGRATIONS = Object.freeze([
  Object.freeze({
    name: "202608260020_038_expand_identity_access_boundaries.sql",
    feature: "identityAccessFoundation" as const,
  }),
  Object.freeze({
    name: "202608280020_053_harden_member_role_management.sql",
    feature: "memberRoleManagement" as const,
  }),
  Object.freeze({
    name: "202608290010_054_support_multi_role_identity_sessions.sql",
    feature: "multiRoleSessions" as const,
  }),
  Object.freeze({
    name: "202609070010_055_internal_email_identity.sql",
    feature: "internalIdentity" as const,
  }),
  Object.freeze({
    name: "202609080010_056_email_provider_settings.sql",
    feature: "providerSettings" as const,
  }),
  Object.freeze({
    name: "202609080020_057_email_invitation_template.sql",
    feature: "invitationTemplate" as const,
  }),
]);

type FeatureName = (typeof MIGRATIONS)[number]["feature"];
type FeatureState = Readonly<Record<FeatureName, "absent" | "ready" | "partial">>;

const dryRun = process.argv.length === 3 && process.argv[2] === "--dry-run";
if (process.argv.length > (dryRun ? 3 : 2)) {
  throw new Error("Production UAT internal-email migration arguments were rejected.");
}

if (process.env.VERCEL_ENV !== "production" && !dryRun) {
  console.log("production_uat_internal_email_migrations=038,053-057 status=skipped_non_production");
  process.exit(0);
}

const connectionString = (
  dryRun ? process.env.ONE_ROLE_BASELINE_DATABASE_URL : process.env.TEST_DATABASE_URL
)?.trim();
const expectedDatabase = (
  dryRun ? process.env.ONE_ROLE_BASELINE_EXPECTED_DATABASE : process.env.TEST_DATABASE_EXPECTED_NAME
)?.trim();

if (!connectionString || !expectedDatabase) {
  throw new Error("Production UAT internal-email migrations require the configured test database.");
}

const client = new Client({
  connectionString,
  application_name: "tianxing-production-uat-internal-email-migrations",
  ssl: { rejectUnauthorized: true },
});

try {
  await client.connect();
  await client.query("BEGIN");
  await client.query("SET LOCAL lock_timeout = '10s'");
  await client.query("SET LOCAL statement_timeout = '90s'");
  await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_ID]);

  const preflight = await readState();
  assertTargetIdentity(preflight.databaseName, preflight.userName);
  if (!preflight.prerequisitesReady) {
    throw new Error("Production UAT internal-email migration prerequisites are missing.");
  }
  let preflightFeatures = preflight.features;
  console.log(
    `production_uat_internal_email_migrations=038,053-057 preflight=${serializeFeatureState(preflightFeatures)}`,
  );
  if (preflightFeatures.identityAccessFoundation === "partial") {
    const foundationComponents = await readFoundationComponents();
    console.log(
      `production_uat_internal_email_migrations=038 foundation_components=${serializeFoundationComponents(foundationComponents)}`,
    );
    if (!onlyWorkspaceResolverMissing(foundationComponents)) {
      throw new Error("Production UAT internal-email migrations found an unsupported foundation state.");
    }
    await installWorkspaceResolverRepair();
    preflightFeatures = (await readState()).features;
  }
  assertNoPartialFeatures(preflightFeatures);

  const applied: string[] = [];
  for (const migration of MIGRATIONS) {
    const current = await readState();
    assertNoPartialFeatures(current.features);
    if (current.features[migration.feature] === "ready") continue;

    const migrationSql = await readFile(
      new URL(`../../db/migrations/${migration.name}`, import.meta.url),
      "utf8",
    );
    if (migration.feature === "identityAccessFoundation") {
      await relaxIdentityAccessRlsForMigration();
    }
    await client.query(migrationSql);
    if (migration.feature === "identityAccessFoundation") {
      await restoreIdentityAccessRlsAfterMigration();
    }
    applied.push(migration.name);

    const installed = await readState();
    if (installed.features[migration.feature] !== "ready") {
      throw new Error(
        `Production UAT internal-email migration postflight verification failed for ${migration.feature}.`,
      );
    }
    if (migration.feature === "identityAccessFoundation") {
      await backfillEmployeeProfiles();
    }
  }

  await backfillEmployeeProfiles();

  const postflight = await readState();
  assertTargetIdentity(postflight.databaseName, postflight.userName);
  assertNoPartialFeatures(postflight.features);
  if (Object.values(postflight.features).some((state) => state !== "ready")) {
    throw new Error("Production UAT internal-email migrations are incomplete.");
  }

  await client.query(dryRun ? "ROLLBACK" : "COMMIT");
  console.log(
    `production_uat_internal_email_migrations=038,053-057 status=${dryRun ? "verified" : "ready"} applied=${applied.length}`,
  );
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  const postgresCode = readPostgresCode(error);
  console.error(
    `production_uat_internal_email_migrations=038,053-057 status=failed postgres_code=${postgresCode}`,
  );
  throw new Error("Production UAT internal-email migrations failed.", { cause: error });
} finally {
  await client.end().catch(() => undefined);
}

async function readState(): Promise<Readonly<{
  databaseName: string;
  userName: string;
  prerequisitesReady: boolean;
  features: FeatureState;
}>> {
  const result = await client.query<{
    database_name: string;
    user_name: string;
    prerequisites_ready: boolean;
    identity_access_foundation_count: string;
    member_role_management_count: string;
    multi_role_sessions_count: string;
    internal_identity_count: string;
    provider_settings_count: string;
    invitation_template_count: string;
  }>({
    text: `SELECT current_database() AS database_name,
                  current_user AS user_name,
                  (
                    to_regclass('public.identity_users') IS NOT NULL
                    AND to_regclass('public.identity_invites') IS NOT NULL
                    AND to_regclass('public.identity_sessions') IS NOT NULL
                    AND to_regclass('public.identity_database_test_credentials') IS NOT NULL
                    AND to_regclass('public.access_organizations') IS NOT NULL
                    AND to_regclass('public.access_organization_memberships') IS NOT NULL
                    AND to_regclass('public.access_role_bindings') IS NOT NULL
                  ) AS prerequisites_ready,
                  (
                    (to_regclass('public.access_employee_profiles') IS NOT NULL)::int
                    + (EXISTS (
                        SELECT 1 FROM information_schema.columns
                         WHERE table_schema = 'public' AND table_name = 'identity_users'
                           AND column_name = 'activated_at'
                      ))::int
                    + (EXISTS (
                        SELECT 1 FROM information_schema.columns
                         WHERE table_schema = 'public' AND table_name = 'access_organization_memberships'
                           AND column_name = 'activated_at'
                      ))::int
                    + (EXISTS (
                        SELECT 1 FROM information_schema.columns
                         WHERE table_schema = 'public' AND table_name = 'identity_invites'
                           AND column_name = 'expired_at'
                      ))::int
                    + (EXISTS (
                        SELECT 1 FROM information_schema.columns
                         WHERE table_schema = 'public' AND table_name = 'identity_invites'
                           AND column_name = 'credential_version'
                      ))::int
                    + (EXISTS (
                        SELECT 1 FROM information_schema.columns
                         WHERE table_schema = 'public' AND table_name = 'access_scope_grants'
                           AND column_name = 'expired_at'
                      ))::int
                    + (to_regprocedure('public.identity_resolve_session_principal(bytea,timestamp with time zone,boolean)') IS NOT NULL)::int
                    + (to_regprocedure('public.access_resolve_workspace_context(uuid)') IS NOT NULL)::int
                  )::text AS identity_access_foundation_count,
                  (
                    (EXISTS (
                        SELECT 1 FROM pg_trigger AS trigger_row
                        JOIN pg_class AS table_row ON table_row.oid = trigger_row.tgrelid
                        JOIN pg_namespace AS schema_row ON schema_row.oid = table_row.relnamespace
                         WHERE schema_row.nspname = 'public'
                           AND table_row.relname = 'access_employee_profiles'
                           AND trigger_row.tgname = 'access_employee_profiles_validate_write'
                           AND NOT trigger_row.tgisinternal
                      ))::int
                  )::text AS member_role_management_count,
                  (
                    COALESCE(position('v_role_count' IN pg_get_functiondef(
                      to_regprocedure('public.identity_database_test_complete_login(uuid,bigint,boolean,uuid,bytea,timestamp with time zone)')
                    )) > 0, false)::int
                    + COALESCE(position('v_role_count' IN pg_get_functiondef(
                      to_regprocedure('public.identity_database_test_resolve_session(bytea,timestamp with time zone,boolean)')
                    )) > 0, false)::int
                    + COALESCE(position('v_role_count' IN pg_get_functiondef(
                      to_regprocedure('public.identity_database_test_provision_credential(text,text,bytea,bytea,boolean)')
                    )) > 0, false)::int
                  )::text AS multi_role_sessions_count,
                  (
                    (to_regclass('public.identity_internal_credentials') IS NOT NULL)::int
                    + (to_regprocedure('public.identity_internal_email_lookup_credential(text)') IS NOT NULL)::int
                    + (to_regprocedure('public.identity_internal_email_complete_login(uuid,bigint,boolean,uuid,bytea,timestamp with time zone)') IS NOT NULL)::int
                    + (to_regprocedure('public.identity_internal_email_resolve_session(bytea,timestamp with time zone,boolean)') IS NOT NULL)::int
                    + (to_regprocedure('public.identity_internal_email_revoke_session(bytea,text)') IS NOT NULL)::int
                    + (to_regprocedure('public.identity_internal_email_create_invite(uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,bytea,timestamp with time zone)') IS NOT NULL)::int
                    + (to_regprocedure('public.identity_internal_email_activate_invite(uuid,uuid,uuid,bytea,bytea,bytea,text,uuid,bytea,timestamp with time zone)') IS NOT NULL)::int
                  )::text AS internal_identity_count,
                  (
                    (to_regclass('public.email_provider_settings') IS NOT NULL)::int
                    + (to_regprocedure('public.email_validate_provider_settings_write()') IS NOT NULL)::int
                    + (to_regprocedure('public.email_reject_provider_settings_delete()') IS NOT NULL)::int
                    + (EXISTS (
                        SELECT 1 FROM pg_trigger AS trigger_row
                        JOIN pg_class AS table_row ON table_row.oid = trigger_row.tgrelid
                        JOIN pg_namespace AS schema_row ON schema_row.oid = table_row.relnamespace
                         WHERE schema_row.nspname = 'public'
                           AND table_row.relname = 'email_provider_settings'
                           AND trigger_row.tgname = 'email_provider_settings_validate_write'
                           AND NOT trigger_row.tgisinternal
                      ))::int
                    + (EXISTS (
                        SELECT 1 FROM pg_trigger AS trigger_row
                        JOIN pg_class AS table_row ON table_row.oid = trigger_row.tgrelid
                        JOIN pg_namespace AS schema_row ON schema_row.oid = table_row.relnamespace
                         WHERE schema_row.nspname = 'public'
                           AND table_row.relname = 'email_provider_settings'
                           AND trigger_row.tgname = 'email_provider_settings_reject_delete'
                           AND NOT trigger_row.tgisinternal
                      ))::int
                  )::text AS provider_settings_count,
                  (
                    (to_regclass('public.email_templates') IS NOT NULL)::int
                    + (to_regprocedure('public.email_validate_template_write()') IS NOT NULL)::int
                    + (to_regprocedure('public.email_reject_template_delete()') IS NOT NULL)::int
                    + (EXISTS (
                        SELECT 1 FROM pg_trigger AS trigger_row
                        JOIN pg_class AS table_row ON table_row.oid = trigger_row.tgrelid
                        JOIN pg_namespace AS schema_row ON schema_row.oid = table_row.relnamespace
                         WHERE schema_row.nspname = 'public'
                           AND table_row.relname = 'email_templates'
                           AND trigger_row.tgname = 'email_templates_validate_write'
                           AND NOT trigger_row.tgisinternal
                      ))::int
                    + (EXISTS (
                        SELECT 1 FROM pg_trigger AS trigger_row
                        JOIN pg_class AS table_row ON table_row.oid = trigger_row.tgrelid
                        JOIN pg_namespace AS schema_row ON schema_row.oid = table_row.relnamespace
                         WHERE schema_row.nspname = 'public'
                           AND table_row.relname = 'email_templates'
                           AND trigger_row.tgname = 'email_templates_reject_delete'
                           AND NOT trigger_row.tgisinternal
                      ))::int
                  )::text AS invitation_template_count`,
  });
  const row = result.rows[0];
  if (!row) throw new Error("Production UAT internal-email migration preflight returned no row.");

  return Object.freeze({
    databaseName: row.database_name,
    userName: row.user_name,
    prerequisitesReady: row.prerequisites_ready,
    features: Object.freeze({
      identityAccessFoundation: featureState(Number(row.identity_access_foundation_count), 8),
      memberRoleManagement: featureState(Number(row.member_role_management_count), 1),
      multiRoleSessions: featureState(Number(row.multi_role_sessions_count), 3),
      internalIdentity: featureState(Number(row.internal_identity_count), 7),
      providerSettings: featureState(Number(row.provider_settings_count), 5),
      invitationTemplate: featureState(Number(row.invitation_template_count), 5),
    }),
  });
}

function featureState(count: number, readyCount: number): "absent" | "ready" | "partial" {
  if (count === 0) return "absent";
  if (count === readyCount) return "ready";
  return "partial";
}

function serializeFeatureState(features: FeatureState): string {
  return MIGRATIONS
    .map((migration) => `${migration.feature}:${features[migration.feature]}`)
    .join(",");
}

type FoundationComponents = Readonly<{
  employee_profiles: boolean;
  user_lifecycle: boolean;
  membership_lifecycle: boolean;
  invite_expiry: boolean;
  invite_credential: boolean;
  scope_expiry: boolean;
  session_resolver: boolean;
  workspace_resolver: boolean;
}>;

async function readFoundationComponents(): Promise<FoundationComponents> {
  const result = await client.query<FoundationComponents>({
    text: `SELECT
      to_regclass('public.access_employee_profiles') IS NOT NULL AS employee_profiles,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='identity_users' AND column_name='activated_at') AS user_lifecycle,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='access_organization_memberships' AND column_name='activated_at') AS membership_lifecycle,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='identity_invites' AND column_name='expired_at') AS invite_expiry,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='identity_invites' AND column_name='credential_version') AS invite_credential,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='access_scope_grants' AND column_name='expired_at') AS scope_expiry,
      to_regprocedure('public.identity_resolve_session_principal(bytea,timestamp with time zone,boolean)') IS NOT NULL AS session_resolver,
      to_regprocedure('public.access_resolve_workspace_context(uuid)') IS NOT NULL AS workspace_resolver`,
  });
  const row = result.rows[0];
  if (!row) throw new Error("Production UAT foundation inspection returned no row.");
  return Object.freeze(row);
}

function serializeFoundationComponents(components: FoundationComponents): string {
  return Object.entries(components)
    .map(([name, present]) => `${name}:${present ? "1" : "0"}`)
    .join(",");
}

function onlyWorkspaceResolverMissing(components: FoundationComponents): boolean {
  return !components.workspace_resolver
    && Object.entries(components).every(([name, present]) =>
      name === "workspace_resolver" || present
    );
}

async function installWorkspaceResolverRepair(): Promise<void> {
  await client.query(`
    CREATE OR REPLACE FUNCTION public.access_resolve_workspace_context(p_user_id uuid)
    RETURNS TABLE (
      user_id uuid,
      organization_id uuid,
      membership_id uuid,
      role_binding_id uuid,
      role text,
      membership_record_version bigint,
      role_binding_record_version bigint
    )
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $function$
      SELECT membership.user_id,
             membership.organization_id,
             membership.id,
             role_binding.id,
             role_binding.role,
             membership.record_version,
             role_binding.record_version
        FROM public.identity_users AS identity_user
        JOIN public.access_organization_memberships AS membership
          ON membership.user_id = identity_user.id
         AND membership.status = 'active'
        JOIN public.access_organizations AS organization
          ON organization.id = membership.organization_id
         AND organization.status = 'active'
        JOIN public.access_role_bindings AS role_binding
          ON role_binding.organization_id = membership.organization_id
         AND role_binding.membership_id = membership.id
         AND role_binding.user_id = membership.user_id
         AND role_binding.status = 'active'
         AND role_binding.role IN ('founder', 'admin', 'advisor', 'contractor')
       WHERE identity_user.id = p_user_id
         AND identity_user.status = 'active'
       ORDER BY role_binding.id
    $function$;
    REVOKE ALL ON FUNCTION public.access_resolve_workspace_context(uuid) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION public.access_resolve_workspace_context(uuid) TO tianxing_app;
  `);
}

function assertTargetIdentity(databaseName: string, userName: string): void {
  if (databaseName !== expectedDatabase || userName !== EXPECTED_APPLICATION_USER) {
    throw new Error("Production UAT internal-email migration target identity was rejected.");
  }
}

function assertNoPartialFeatures(features: FeatureState): void {
  if (Object.values(features).includes("partial")) {
    throw new Error("Production UAT internal-email migrations found a partial migration state.");
  }
  if (
    (features.memberRoleManagement === "ready"
      || features.internalIdentity === "ready")
    && features.identityAccessFoundation !== "ready"
  ) {
    throw new Error("Production UAT internal-email migrations found an invalid dependency state.");
  }
}

async function backfillEmployeeProfiles(): Promise<void> {
  await client.query("ALTER TABLE public.access_employee_profiles NO FORCE ROW LEVEL SECURITY");
  await client.query(`
    INSERT INTO public.access_employee_profiles (
      membership_id, organization_id, display_name, employment_type,
      record_version, created_at, updated_at
    )
    SELECT membership.id,
           membership.organization_id,
           left(split_part(identity_user.normalized_email, '@', 1), 100),
           CASE WHEN EXISTS (
             SELECT 1 FROM public.access_role_bindings AS role_binding
              WHERE role_binding.membership_id = membership.id
                AND role_binding.organization_id = membership.organization_id
                AND role_binding.user_id = membership.user_id
                AND role_binding.role = 'contractor'
                AND role_binding.status = 'active'
           ) THEN 'PART_TIME' ELSE 'FULL_TIME' END,
           1, membership.created_at, transaction_timestamp()
      FROM public.access_organization_memberships AS membership
      JOIN public.identity_users AS identity_user ON identity_user.id = membership.user_id
     WHERE NOT EXISTS (
       SELECT 1 FROM public.access_employee_profiles AS employee_profile
        WHERE employee_profile.membership_id = membership.id
     )
  `);
  await client.query("ALTER TABLE public.access_employee_profiles FORCE ROW LEVEL SECURITY");
}

async function relaxIdentityAccessRlsForMigration(): Promise<void> {
  for (const table of [
    "access_organization_memberships",
    "access_role_bindings",
    "access_scope_grants",
    "identity_invites",
    "identity_sessions",
  ]) {
    await client.query(`ALTER TABLE public.${table} NO FORCE ROW LEVEL SECURITY`);
  }
}

async function restoreIdentityAccessRlsAfterMigration(): Promise<void> {
  for (const table of [
    "access_organization_memberships",
    "access_role_bindings",
    "access_scope_grants",
    "identity_invites",
    "identity_sessions",
  ]) {
    await client.query(`ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY`);
  }
}

function readPostgresCode(error: unknown): string {
  if (typeof error !== "object" || error === null) return "unknown";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : "unknown";
}
