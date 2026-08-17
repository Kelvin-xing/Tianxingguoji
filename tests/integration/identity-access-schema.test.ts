import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import type { Client } from "pg";

import {
  SESSION_POLICY,
  evaluateSession,
  selectAvailableSessionSlot,
} from "../../modules/identity/domain/contract.ts";
import {
  COLLABORATOR_CAPABILITIES,
  COLLABORATOR_SCOPES,
  GRANT_POLICY,
  calculateDefaultGrantExpiry,
  evaluateScopeGrant,
} from "../../modules/access/domain/contract.ts";
import { planMigration } from "../../scripts/db/plan-migration.ts";

test("allocates at most three active sessions without implicit eviction", () => {
  assert.deepEqual(SESSION_POLICY, {
    idleTimeoutMs: 15 * 60 * 1_000,
    absoluteTimeoutMs: 8 * 60 * 60 * 1_000,
    sensitiveReauthenticationMaxAgeMs: 5 * 60 * 1_000,
    maximumActiveSessions: 3,
  });

  assert.deepEqual(selectAvailableSessionSlot([1, 2]), { allowed: true, slot: 3 });
  assert.deepEqual(selectAvailableSessionSlot([1, 2, 3]), {
    allowed: false,
    code: "SESSION_LIMIT_REACHED",
  });
});

test("denies stale, expired, disabled, and insufficiently reauthenticated sessions", () => {
  const nowMs = Date.parse("2026-08-02T05:00:00.000Z");
  const validSession = {
    nowMs,
    sensitiveAction: false,
    userStatus: "active" as const,
    currentSessionVersion: 4,
    sessionStatus: "active" as const,
    capturedSessionVersion: 4,
    organizationStatus: "active" as const,
    membershipStatus: "active" as const,
    idleExpiresAtMs: nowMs + 1,
    absoluteExpiresAtMs: nowMs + 1,
    reauthenticatedAtMs: null,
  };

  assert.deepEqual(evaluateSession(validSession), { allowed: true });
  assert.deepEqual(
    evaluateSession({ ...validSession, capturedSessionVersion: 3 }),
    { allowed: false, code: "SESSION_VERSION_STALE" },
  );
  assert.deepEqual(
    evaluateSession({ ...validSession, userStatus: "disabled" }),
    { allowed: false, code: "USER_DISABLED" },
  );
  assert.deepEqual(
    evaluateSession({ ...validSession, userStatus: "invited" }),
    { allowed: false, code: "USER_DISABLED" },
  );
  assert.deepEqual(
    evaluateSession({ ...validSession, organizationStatus: "disabled" }),
    { allowed: false, code: "ORGANIZATION_INACTIVE" },
  );
  assert.deepEqual(
    evaluateSession({ ...validSession, membershipStatus: "disabled" }),
    { allowed: false, code: "MEMBERSHIP_INACTIVE" },
  );
  assert.deepEqual(
    evaluateSession({ ...validSession, idleExpiresAtMs: nowMs }),
    { allowed: false, code: "SESSION_IDLE_EXPIRED" },
  );
  assert.deepEqual(
    evaluateSession({ ...validSession, absoluteExpiresAtMs: nowMs }),
    { allowed: false, code: "SESSION_ABSOLUTE_EXPIRED" },
  );
  assert.deepEqual(
    evaluateSession({ ...validSession, sensitiveAction: true }),
    { allowed: false, code: "SENSITIVE_REAUTH_REQUIRED" },
  );
  assert.deepEqual(
    evaluateSession({
      ...validSession,
      sensitiveAction: true,
      reauthenticatedAtMs: nowMs - SESSION_POLICY.sensitiveReauthenticationMaxAgeMs,
    }),
    { allowed: true },
  );
  assert.deepEqual(
    evaluateSession({
      ...validSession,
      sensitiveAction: true,
      reauthenticatedAtMs:
        nowMs - SESSION_POLICY.sensitiveReauthenticationMaxAgeMs - 1,
    }),
    { allowed: false, code: "SENSITIVE_REAUTH_REQUIRED" },
  );
});

test("enforces bounded collaborator grants and denies every export", () => {
  assert.deepEqual(COLLABORATOR_SCOPES, [
    "case_summary",
    "education_profile",
    "school_targets",
    "task_workspace",
    "communications",
    "identity_contact",
    "internal_notes",
  ]);
  assert.deepEqual(COLLABORATOR_CAPABILITIES, ["view", "comment", "edit"]);
  assert.deepEqual(GRANT_POLICY, {
    defaultDurationMs: 7 * 24 * 60 * 60 * 1_000,
    maximumDurationMs: 7 * 24 * 60 * 60 * 1_000,
    sensitiveScopes: ["identity_contact", "internal_notes"],
  });

  const nowMs = Date.parse("2026-08-02T05:00:00.000Z");
  assert.equal(
    calculateDefaultGrantExpiry(nowMs),
    Date.parse("2026-08-09T05:00:00.000Z"),
  );

  const ordinaryGrant = {
    nowMs,
    organizationId: "organization-1",
    caseId: "case-1",
    requestedScope: "case_summary" as const,
    requestedCapability: "view" as const,
    userStatus: "active" as const,
    organizationStatus: "active" as const,
    membershipStatus: "active" as const,
    advisorRoleBindingStatus: "active" as const,
    collaboratorStatus: "active" as const,
    grantStatus: "active" as const,
    grantOrganizationId: "organization-1",
    grantCaseId: "case-1",
    grantScope: "case_summary" as const,
    grantCapability: "view" as const,
    startsAtMs: nowMs - 1,
    expiresAtMs: nowMs + 1,
    requestedByUserId: "advisor-1",
    approvedByUserId: null,
    approverRole: null,
  };

  assert.deepEqual(evaluateScopeGrant(ordinaryGrant), { allowed: true });
  assert.deepEqual(
    evaluateScopeGrant({ ...ordinaryGrant, requestedCapability: "export" }),
    { allowed: false, code: "COLLABORATOR_EXPORT_DENIED" },
  );
  assert.deepEqual(
    evaluateScopeGrant({ ...ordinaryGrant, expiresAtMs: nowMs }),
    { allowed: false, code: "GRANT_EXPIRED" },
  );
  assert.deepEqual(
    evaluateScopeGrant({ ...ordinaryGrant, caseId: "case-2" }),
    { allowed: false, code: "GRANT_CONTEXT_MISMATCH" },
  );
  assert.deepEqual(
    evaluateScopeGrant({ ...ordinaryGrant, advisorRoleBindingStatus: "revoked" }),
    { allowed: false, code: "ADVISOR_ROLE_INACTIVE" },
  );
  assert.deepEqual(
    evaluateScopeGrant({ ...ordinaryGrant, organizationStatus: "disabled" }),
    { allowed: false, code: "ORGANIZATION_INACTIVE" },
  );

  const sensitiveGrant = {
    ...ordinaryGrant,
    requestedScope: "identity_contact" as const,
    grantScope: "identity_contact" as const,
  };
  assert.deepEqual(evaluateScopeGrant(sensitiveGrant), {
    allowed: false,
    code: "SENSITIVE_GRANT_NOT_APPROVED",
  });
  assert.deepEqual(
    evaluateScopeGrant({
      ...sensitiveGrant,
      approvedByUserId: "founder-1",
      approverRole: "founder",
    }),
    { allowed: true },
  );
  assert.deepEqual(
    evaluateScopeGrant({
      ...sensitiveGrant,
      approvedByUserId: "advisor-1",
      approverRole: "founder",
    }),
    { allowed: false, code: "SENSITIVE_GRANT_NOT_APPROVED" },
  );
});

test("publishes the approved identity/access SQL through the migration planner", async () => {
  const plan = await planMigration({
    migrationDirectory: resolve("db/migrations"),
    snapshot: {
      target: "empty",
      applied: [],
      expectedSchemaSha256: null,
      actualSchemaSha256: null,
    },
  });

  assert.equal(plan.status, "pass");
  assert.deepEqual(plan.findings, []);
  assert.deepEqual(
    plan.migrations.find(
      ({ name }) => name === "202608021330_001_expand_identity_access.sql",
    ),
    {
      name: "202608021330_001_expand_identity_access.sql",
      sha256: "fd3ebd439502eb570882a4daca910dd6dd124810d4a3764c511b05b5db5a5457",
      state: "pending",
    },
  );
});

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

test(
  "applies the additive identity and access schema to empty PostgreSQL",
  { skip: testDatabaseUrl ? false : "TEST_DATABASE_URL is required for PostgreSQL evidence" },
  async () => {
    const { Client } = await import("pg");
    const migrationSql = await readFile(
      resolve("db/migrations/202608021330_001_expand_identity_access.sql"),
      "utf8",
    );
    const client = new Client({ connectionString: testDatabaseUrl });

    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query(migrationSql);
      const result = await client.query<{ tablename: string }>(
        `SELECT tablename
           FROM pg_catalog.pg_tables
          WHERE schemaname = 'public'
            AND tablename = ANY($1::text[])
          ORDER BY tablename`,
        [[
          "access_case_collaborators",
          "access_organization_memberships",
          "access_organizations",
          "access_role_bindings",
          "access_scope_grants",
          "identity_invites",
          "identity_provider_identities",
          "identity_sessions",
          "identity_users",
        ]],
      );

      assert.deepEqual(
        result.rows.map(({ tablename }) => tablename),
        [
          "access_case_collaborators",
          "access_organization_memberships",
          "access_organizations",
          "access_role_bindings",
          "access_scope_grants",
          "identity_invites",
          "identity_provider_identities",
          "identity_sessions",
          "identity_users",
        ],
      );

      await seedIdentityAndAccessPrincipals(client);
      await assertProviderAndOrganizationConstraints(client);
      await assertInviteTransitions(client);
      await assertSessionConstraints(client);
      await assertCollaboratorAndGrantConstraints(client);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      await client.end();
    }
  },
);

async function seedIdentityAndAccessPrincipals(client: Client): Promise<void> {
  await client.query(`
    INSERT INTO identity_users (id, normalized_email, status)
    VALUES
      ('00000000-0000-4000-8000-000000000001', 'founder@example.invalid', 'active'),
      ('00000000-0000-4000-8000-000000000002', 'advisor@example.invalid', 'active'),
      ('00000000-0000-4000-8000-000000000003', 'other@example.invalid', 'active');

    INSERT INTO access_organizations (id, display_name, status, created_by_user_id)
    VALUES (
      '10000000-0000-4000-8000-000000000001',
      'Tianxing Release 1',
      'active',
      '00000000-0000-4000-8000-000000000001'
    );

    INSERT INTO access_organization_memberships (
      id,
      organization_id,
      user_id,
      status,
      created_by_user_id
    )
    VALUES
      (
        '20000000-0000-4000-8000-000000000001',
        '10000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-000000000001',
        'active',
        '00000000-0000-4000-8000-000000000001'
      ),
      (
        '20000000-0000-4000-8000-000000000002',
        '10000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-000000000002',
        'active',
        '00000000-0000-4000-8000-000000000001'
      );

    INSERT INTO access_role_bindings (
      id,
      organization_id,
      membership_id,
      user_id,
      role,
      status,
      created_by_user_id
    )
    VALUES
      (
        '30000000-0000-4000-8000-000000000001',
        '10000000-0000-4000-8000-000000000001',
        '20000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-000000000001',
        'founder',
        'active',
        '00000000-0000-4000-8000-000000000001'
      ),
      (
        '30000000-0000-4000-8000-000000000002',
        '10000000-0000-4000-8000-000000000001',
        '20000000-0000-4000-8000-000000000002',
        '00000000-0000-4000-8000-000000000002',
        'advisor',
        'active',
        '00000000-0000-4000-8000-000000000001'
      );
  `);
}

async function assertProviderAndOrganizationConstraints(client: Client): Promise<void> {
  await client.query(`
    INSERT INTO identity_provider_identities (
      id,
      user_id,
      provider,
      provider_subject,
      created_by_user_id
    )
    VALUES (
      '40000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
      'cognito',
      'ap-east-1_subject_advisor',
      '00000000-0000-4000-8000-000000000001'
    );
  `);

  await expectSqlState(
    client,
    () =>
      client.query(`
        INSERT INTO identity_provider_identities (
          id,
          user_id,
          provider,
          provider_subject
        )
        VALUES (
          '40000000-0000-4000-8000-000000000002',
          '00000000-0000-4000-8000-000000000003',
          'cognito',
          'ap-east-1_subject_advisor'
        );
      `),
    "23505",
    "identity_provider_identities_provider_subject_key",
  );

  await expectSqlState(
    client,
    () =>
      client.query(`
        INSERT INTO access_organizations (id, display_name, status)
        VALUES (
          '10000000-0000-4000-8000-000000000002',
          'Second active organization',
          'active'
        );
      `),
    "23505",
    "access_organizations_one_active_idx",
  );
}

async function assertSessionConstraints(client: Client): Promise<void> {
  await client.query(`
    INSERT INTO identity_sessions (
      id,
      user_id,
      organization_id,
      membership_id,
      secret_hash,
      captured_session_version,
      session_slot,
      status,
      provider_token_ciphertext,
      provider_token_key_version,
      last_seen_at,
      idle_expires_at,
      absolute_expires_at,
      created_at,
      updated_at
    )
    SELECT
      ('50000000-0000-4000-8000-' || lpad(slot::text, 12, '0'))::uuid,
      '00000000-0000-4000-8000-000000000002'::uuid,
      '10000000-0000-4000-8000-000000000001'::uuid,
      '20000000-0000-4000-8000-000000000002'::uuid,
      decode(repeat(lpad(slot::text, 2, '0'), 32), 'hex'),
      1,
      slot,
      'active',
      decode('aa', 'hex'),
      'test-key-v1',
      '2026-08-02T05:00:00Z'::timestamptz,
      '2026-08-02T05:15:00Z'::timestamptz,
      '2026-08-02T13:00:00Z'::timestamptz,
      '2026-08-02T05:00:00Z'::timestamptz,
      '2026-08-02T05:00:00Z'::timestamptz
    FROM generate_series(1, 3) AS slot;
  `);

  const activeBeforeLimit = await client.query<{ count: string }>(`
    SELECT count(*)::text AS count
      FROM identity_sessions
     WHERE user_id = '00000000-0000-4000-8000-000000000002'
       AND status = 'active';
  `);
  assert.equal(activeBeforeLimit.rows[0]?.count, "3");

  await expectSqlState(
    client,
    () =>
      client.query(`
        UPDATE identity_sessions
           SET captured_session_version = captured_session_version + 1,
               updated_at = transaction_timestamp()
         WHERE id = '50000000-0000-4000-8000-000000000001';
      `),
    "23514",
    "identity_sessions_immutable_fields_check",
  );

  await expectSqlState(
    client,
    () =>
      client.query(`
        INSERT INTO identity_sessions (
          id,
          user_id,
          organization_id,
          membership_id,
          secret_hash,
          captured_session_version,
          session_slot,
          status,
          provider_token_ciphertext,
          provider_token_key_version,
          last_seen_at,
          idle_expires_at,
          absolute_expires_at,
          created_at,
          updated_at
        ) VALUES (
          '50000000-0000-4000-8000-000000000006',
          '00000000-0000-4000-8000-000000000002',
          '10000000-0000-4000-8000-000000000001',
          '20000000-0000-4000-8000-000000000002',
          decode(repeat('06', 32), 'hex'),
          2,
          1,
          'active',
          decode('aa', 'hex'),
          'test-key-v1',
          '2026-08-02T05:00:00Z',
          '2026-08-02T05:15:00Z',
          '2026-08-02T13:00:00Z',
          '2026-08-02T05:00:00Z',
          '2026-08-02T05:00:00Z'
        );
      `),
    "23514",
    "identity_sessions_current_user_version_check",
  );

  await expectSqlState(
    client,
    () =>
      client.query(`
        INSERT INTO identity_sessions (
          id,
          user_id,
          organization_id,
          membership_id,
          secret_hash,
          captured_session_version,
          session_slot,
          status,
          provider_token_ciphertext,
          provider_token_key_version,
          last_seen_at,
          idle_expires_at,
          absolute_expires_at,
          created_at,
          updated_at
        ) VALUES (
          '50000000-0000-4000-8000-000000000004',
          '00000000-0000-4000-8000-000000000002',
          '10000000-0000-4000-8000-000000000001',
          '20000000-0000-4000-8000-000000000002',
          decode(repeat('04', 32), 'hex'),
          1,
          4,
          'active',
          decode('aa', 'hex'),
          'test-key-v1',
          '2026-08-02T05:00:00Z',
          '2026-08-02T05:15:00Z',
          '2026-08-02T13:00:00Z',
          '2026-08-02T05:00:00Z',
          '2026-08-02T05:00:00Z'
        );
      `),
    "23514",
    "identity_sessions_slot_check",
  );

  await expectSqlState(
    client,
    () =>
      client.query(`
        INSERT INTO identity_sessions (
          id,
          user_id,
          organization_id,
          membership_id,
          secret_hash,
          captured_session_version,
          session_slot,
          status,
          last_seen_at,
          idle_expires_at,
          absolute_expires_at,
          created_at,
          updated_at
        ) VALUES (
          '50000000-0000-4000-8000-000000000005',
          '00000000-0000-4000-8000-000000000002',
          '10000000-0000-4000-8000-000000000001',
          '20000000-0000-4000-8000-000000000002',
          decode('05', 'hex'),
          1,
          1,
          'expired',
          '2026-08-02T05:00:00Z',
          '2026-08-02T05:15:00Z',
          '2026-08-02T13:00:00Z',
          '2026-08-02T05:00:00Z',
          '2026-08-02T05:00:00Z'
        );
      `),
    "23514",
    "identity_sessions_secret_hash_check",
  );

  await expectSqlState(
    client,
    () =>
      client.query(`
        UPDATE identity_users
           SET status = 'disabled', updated_at = transaction_timestamp()
         WHERE id = '00000000-0000-4000-8000-000000000002';
      `),
    "23514",
    "identity_users_disable_session_version_check",
  );

  await client.query(`
    UPDATE identity_users
       SET status = 'disabled',
           session_version = session_version + 1,
           record_version = record_version + 1,
           updated_at = transaction_timestamp()
     WHERE id = '00000000-0000-4000-8000-000000000002';
  `);
  const revokedAfterDisable = await client.query<{ active: string; revoked: string }>(`
    SELECT
      count(*) FILTER (WHERE status = 'active')::text AS active,
      count(*) FILTER (WHERE status = 'revoked')::text AS revoked
      FROM identity_sessions
     WHERE user_id = '00000000-0000-4000-8000-000000000002';
  `);
  assert.deepEqual(revokedAfterDisable.rows[0], { active: "0", revoked: "3" });

  await expectSqlState(
    client,
    () =>
      client.query(`
        UPDATE identity_users
           SET status = 'active', updated_at = transaction_timestamp()
         WHERE id = '00000000-0000-4000-8000-000000000002';
      `),
    "23514",
    "identity_users_status_transition_check",
  );
  await expectSqlState(
    client,
    () =>
      client.query(`
        UPDATE identity_sessions
           SET status = 'active',
               revoked_at = NULL,
               revoke_reason = NULL,
               updated_at = transaction_timestamp()
         WHERE id = '50000000-0000-4000-8000-000000000001';
      `),
    "23514",
    "identity_sessions_status_transition_check",
  );
}

async function assertCollaboratorAndGrantConstraints(client: Client): Promise<void> {
  await client.query(`
    INSERT INTO access_case_collaborators (
      id,
      organization_id,
      case_id,
      user_id,
      membership_id,
      advisor_role_binding_id,
      status,
      starts_at,
      expires_at,
      granted_by_user_id
    ) VALUES (
      '60000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000001',
      '70000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
      '20000000-0000-4000-8000-000000000002',
      '30000000-0000-4000-8000-000000000002',
      'active',
      '2026-08-02T05:00:00Z',
      '2026-08-09T05:00:00Z',
      '00000000-0000-4000-8000-000000000001'
    );
  `);

  await expectSqlState(
    client,
    () =>
      client.query(`
        INSERT INTO access_case_collaborators (
          id,
          organization_id,
          case_id,
          user_id,
          membership_id,
          advisor_role_binding_id,
          status,
          starts_at,
          expires_at,
          granted_by_user_id
        ) VALUES (
          '60000000-0000-4000-8000-000000000002',
          '10000000-0000-4000-8000-000000000001',
          '70000000-0000-4000-8000-000000000002',
          '00000000-0000-4000-8000-000000000001',
          '20000000-0000-4000-8000-000000000001',
          '30000000-0000-4000-8000-000000000001',
          'active',
          '2026-08-02T05:00:00Z',
          '2026-08-09T05:00:00Z',
          '00000000-0000-4000-8000-000000000001'
        );
      `),
    "23503",
    "access_case_collaborators_advisor_role_fk",
  );

  await expectSqlState(
    client,
    () => insertGrant(client, {
      id: "80000000-0000-4000-8000-000000000001",
      scope: "case_summary",
      capability: "view",
      status: "active",
      expiresAt: "2026-08-09T05:00:00.001Z",
    }),
    "23514",
    "access_scope_grants_duration_check",
  );
  await expectSqlState(
    client,
    () => insertGrant(client, {
      id: "80000000-0000-4000-8000-000000000002",
      scope: "case_summary",
      capability: "export",
      status: "active",
    }),
    "23514",
    "access_scope_grants_capability_check",
  );
  await expectSqlState(
    client,
    async () => {
      await insertGrant(client, {
        id: "80000000-0000-4000-8000-000000000003",
        scope: "identity_contact",
        capability: "view",
        status: "pending_approval",
        requestReason: "Prepare verified family contact pack",
      });
      await activateGrant(client, "80000000-0000-4000-8000-000000000003");
    },
    "23514",
    "access_scope_grants_sensitive_approval_check",
  );
  await expectSqlState(
    client,
    async () => {
      await insertGrant(client, {
        id: "80000000-0000-4000-8000-000000000004",
        scope: "identity_contact",
        capability: "view",
        status: "pending_approval",
        requestReason: "Prepare verified family contact pack",
      });
      await activateGrant(
        client,
        "80000000-0000-4000-8000-000000000004",
        "00000000-0000-4000-8000-000000000002",
      );
    },
    "23514",
    "access_scope_grants_sensitive_approval_check",
  );
  await expectSqlState(
    client,
    () => insertGrant(client, {
      id: "80000000-0000-4000-8000-000000000007",
      scope: "identity_contact",
      capability: "view",
      status: "pending_approval",
    }),
    "23514",
    "access_scope_grants_sensitive_approval_check",
  );
  await expectSqlState(
    client,
    () => insertGrant(client, {
      id: "80000000-0000-4000-8000-000000000005",
      caseId: "70000000-0000-4000-8000-000000000002",
      scope: "case_summary",
      capability: "view",
      status: "active",
    }),
    "23503",
    "access_scope_grants_collaborator_fk",
  );

  await expectSqlState(
    client,
    () => insertGrant(client, {
      id: "80000000-0000-4000-8000-000000000006",
      scope: "identity_contact",
      capability: "view",
      status: "active",
      requestReason: "Prepare verified family contact pack",
      approvedByUserId: "00000000-0000-4000-8000-000000000001",
    }),
    "23514",
    "access_scope_grants_sensitive_initial_state_check",
  );

  await insertGrant(client, {
    id: "80000000-0000-4000-8000-000000000009",
    scope: "identity_contact",
    capability: "view",
    status: "pending_approval",
    requestReason: "Prepare verified family contact pack",
  });
  await activateGrant(
    client,
    "80000000-0000-4000-8000-000000000009",
    "00000000-0000-4000-8000-000000000001",
  );
  await expectSqlState(
    client,
    () =>
      client.query(`
        UPDATE access_scope_grants
           SET scope = 'internal_notes',
               updated_at = transaction_timestamp()
         WHERE id = '80000000-0000-4000-8000-000000000009';
      `),
    "23514",
    "access_scope_grants_immutable_fields_check",
  );
  await expectSqlState(
    client,
    () =>
      client.query(`
        UPDATE access_scope_grants
           SET status = 'pending_approval', updated_at = transaction_timestamp()
         WHERE id = '80000000-0000-4000-8000-000000000009';
      `),
    "23514",
    "access_scope_grants_status_transition_check",
  );

  await insertGrant(client, {
    id: "80000000-0000-4000-8000-000000000008",
    scope: "case_summary",
    capability: "view",
    status: "pending_approval",
  });
  await expectSqlState(
    client,
    () =>
      client.query(`
        UPDATE access_scope_grants
           SET status = 'revoked',
               revoked_by_user_id = '00000000-0000-4000-8000-000000000001',
               revoked_at = transaction_timestamp(),
               revoke_reason = 'Withdraw unapproved request',
               updated_at = transaction_timestamp()
         WHERE id = '80000000-0000-4000-8000-000000000008';
      `),
    "23514",
    "access_scope_grants_status_transition_check",
  );
}

async function assertInviteTransitions(client: Client): Promise<void> {
  await client.query(`
    INSERT INTO identity_invites (
      id,
      organization_id,
      target_user_id,
      invited_by_user_id,
      requested_role,
      secret_hash,
      status,
      expires_at,
      created_at,
      updated_at
    ) VALUES (
      '90000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000003',
      '00000000-0000-4000-8000-000000000001',
      'advisor',
      decode(repeat('09', 32), 'hex'),
      'created',
      '2026-08-03T05:00:00Z',
      '2026-08-02T05:00:00Z',
      '2026-08-02T05:00:00Z'
    );

    UPDATE identity_invites
       SET status = 'redeemed',
           consumed_at = '2026-08-02T05:01:00Z',
           updated_at = '2026-08-02T05:01:00Z'
     WHERE id = '90000000-0000-4000-8000-000000000001';
  `);

  await expectSqlState(
    client,
    () =>
      client.query(`
        UPDATE identity_invites
           SET status = 'created',
               consumed_at = NULL,
               updated_at = '2026-08-02T05:02:00Z'
         WHERE id = '90000000-0000-4000-8000-000000000001';
      `),
    "23514",
    "identity_invites_status_transition_check",
  );
}

interface GrantFixture {
  readonly id: string;
  readonly caseId?: string;
  readonly scope: string;
  readonly capability: string;
  readonly status: string;
  readonly expiresAt?: string;
  readonly requestReason?: string;
  readonly approvedByUserId?: string;
}

async function insertGrant(client: Client, fixture: GrantFixture): Promise<void> {
  await client.query(
    `INSERT INTO access_scope_grants (
       id,
       organization_id,
       case_id,
       collaborator_id,
       scope,
       capability,
       status,
       starts_at,
       expires_at,
       requested_by_user_id,
       request_reason,
       approved_by_user_id,
       approved_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      fixture.id,
      "10000000-0000-4000-8000-000000000001",
      fixture.caseId ?? "70000000-0000-4000-8000-000000000001",
      "60000000-0000-4000-8000-000000000001",
      fixture.scope,
      fixture.capability,
      fixture.status,
      "2026-08-02T05:00:00.000Z",
      fixture.expiresAt ?? "2026-08-09T05:00:00.000Z",
      "00000000-0000-4000-8000-000000000002",
      fixture.requestReason ?? null,
      fixture.approvedByUserId ?? null,
      fixture.approvedByUserId ? "2026-08-02T05:00:00.000Z" : null,
    ],
  );
}

async function activateGrant(
  client: Client,
  grantId: string,
  approvedByUserId: string | null = null,
): Promise<void> {
  await client.query(
    `UPDATE access_scope_grants
        SET status = 'active',
            approved_by_user_id = $2,
            approved_at = CASE WHEN $2::uuid IS NULL THEN NULL ELSE transaction_timestamp() END,
            updated_at = transaction_timestamp()
      WHERE id = $1`,
    [grantId, approvedByUserId],
  );
}

let expectedFailureSequence = 0;

async function expectSqlState(
  client: Client,
  operation: () => Promise<unknown>,
  expectedCode: string,
  expectedConstraint: string,
): Promise<void> {
  const savepoint = `expected_failure_${expectedFailureSequence++}`;
  let caughtError: unknown;

  await client.query(`SAVEPOINT ${savepoint}`);
  try {
    await operation();
  } catch (error: unknown) {
    caughtError = error;
  } finally {
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
  }

  assert.ok(caughtError instanceof Error, `Expected SQLSTATE ${expectedCode}`);
  const databaseError = caughtError as Error & { code?: string; constraint?: string };
  assert.equal(databaseError.code, expectedCode);
  assert.equal(databaseError.constraint, expectedConstraint);
}
