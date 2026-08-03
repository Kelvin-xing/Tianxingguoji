import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import type { Client } from "pg";

import {
  CRM_FORBIDDEN_LEGAL_ID_FIELDS,
  classifyPotentialDuplicate,
  evaluateCrmDeletionTransition,
  evaluatePrimaryContacts,
} from "../../modules/crm/contract.ts";
import { planMigration } from "../../scripts/db/plan-migration.ts";

test("never treats CRM attributes as identity or automatic merge authority", () => {
  assert.deepEqual(CRM_FORBIDDEN_LEGAL_ID_FIELDS, [
    "hkid",
    "mainland_identity_card_number",
    "passport_number",
    "legal_id_image",
    "government_id",
  ]);

  assert.deepEqual(
    classifyPotentialDuplicate({
      displayNameMatch: true,
      dateOfBirthMatch: true,
      emailMatch: true,
      phoneMatch: true,
    }),
    { classification: "review_required", automaticMerge: false },
  );
  assert.deepEqual(
    classifyPotentialDuplicate({
      displayNameMatch: false,
      dateOfBirthMatch: false,
      emailMatch: false,
      phoneMatch: false,
    }),
    { classification: "distinct", automaticMerge: false },
  );
});

test("requires exactly one current primary relationship to an active Guardian", () => {
  const nowMs = Date.parse("2026-08-02T08:00:00.000Z");
  const primary = {
    isPrimaryContact: true,
    startsAtMs: nowMs - 1,
    endsAtMs: null,
    guardianStatus: "active" as const,
  };

  assert.deepEqual(evaluatePrimaryContacts({ nowMs, relationships: [primary] }), {
    allowed: true,
  });
  assert.deepEqual(evaluatePrimaryContacts({ nowMs, relationships: [] }), {
    allowed: false,
    code: "PRIMARY_CONTACT_MISSING",
  });
  assert.deepEqual(
    evaluatePrimaryContacts({ nowMs, relationships: [primary, primary] }),
    { allowed: false, code: "MULTIPLE_PRIMARY_CONTACTS" },
  );
  assert.deepEqual(
    evaluatePrimaryContacts({
      nowMs,
      relationships: [{ ...primary, guardianStatus: "pending_delete" }],
    }),
    { allowed: false, code: "PRIMARY_GUARDIAN_INACTIVE" },
  );
});

test("fails closed on CRM deletion and purge transitions", () => {
  const pendingRequest = {
    currentStatus: "active" as const,
    targetStatus: "pending_delete" as const,
    reason: "Client requested deletion review",
    actorRole: "advisor" as const,
    founderApproved: false,
    retentionCleared: false,
    legalHoldActive: false,
    referencesCleared: false,
  };

  assert.deepEqual(evaluateCrmDeletionTransition(pendingRequest), { allowed: true });
  assert.deepEqual(evaluateCrmDeletionTransition({ ...pendingRequest, reason: "" }), {
    allowed: false,
    code: "DELETION_REASON_REQUIRED",
  });

  const purgeRequest = {
    ...pendingRequest,
    currentStatus: "pending_delete" as const,
    targetStatus: "purged" as const,
    actorRole: "founder" as const,
    founderApproved: true,
    retentionCleared: true,
    referencesCleared: true,
  };
  assert.deepEqual(evaluateCrmDeletionTransition(purgeRequest), { allowed: true });
  assert.deepEqual(
    evaluateCrmDeletionTransition({ ...purgeRequest, actorRole: "admin" }),
    { allowed: false, code: "FOUNDER_APPROVAL_REQUIRED" },
  );
  assert.deepEqual(
    evaluateCrmDeletionTransition({ ...purgeRequest, legalHoldActive: true }),
    { allowed: false, code: "LEGAL_HOLD_ACTIVE" },
  );
  assert.deepEqual(
    evaluateCrmDeletionTransition({ ...purgeRequest, referencesCleared: false }),
    { allowed: false, code: "REFERENCES_REMAIN" },
  );
  assert.deepEqual(
    evaluateCrmDeletionTransition({
      ...purgeRequest,
      currentStatus: "purged",
      targetStatus: "active",
    }),
    { allowed: false, code: "INVALID_LIFECYCLE_TRANSITION" },
  );
});

test("publishes the approved CRM SQL through the migration planner", async () => {
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
    plan.migrations.find(({ name }) => name === "202608021630_002_expand_crm.sql"),
    {
      name: "202608021630_002_expand_crm.sql",
      sha256: "e1e8310a194d95848e063a42b1391076875e58a3dfac30fe024c621b54373b50",
      state: "pending",
    },
  );
});

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

test(
  "applies the additive CRM schema and enforces identity/contact history",
  { skip: testDatabaseUrl ? false : "TEST_DATABASE_URL is required for PostgreSQL evidence" },
  async () => {
    const { Client } = await import("pg");
    const identitySql = await readFile(
      resolve("db/migrations/202608021330_001_expand_identity_access.sql"),
      "utf8",
    );
    const crmSql = await readFile(
      resolve("db/migrations/202608021630_002_expand_crm.sql"),
      "utf8",
    );
    const client = new Client({ connectionString: testDatabaseUrl });

    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query(identitySql);
      await client.query(crmSql);
      await assertCrmTables(client);
      await seedOrganization(client);
      await assertReferralAndIdentityShape(client);
      await assertDeferredPrimaryContactInvariant(client);
      await seedSharedGuardianRelationships(client);
      await assertPrimaryHandoffAndHistory(client);
      await assertLifecycleAndPurgeGuards(client);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      await client.end();
    }
  },
);

async function assertCrmTables(client: Client): Promise<void> {
  const result = await client.query<{ tablename: string }>(
    `SELECT tablename
       FROM pg_catalog.pg_tables
      WHERE schemaname = 'public'
        AND tablename = ANY($1::text[])
      ORDER BY tablename`,
    [[
      "crm_guardians",
      "crm_referral_sources",
      "crm_student_guardian_relationships",
      "crm_students",
    ]],
  );

  assert.deepEqual(result.rows.map(({ tablename }) => tablename), [
    "crm_guardians",
    "crm_referral_sources",
    "crm_student_guardian_relationships",
    "crm_students",
  ]);

  const tenantConstraints = await client.query<{ conname: string }>(`
    SELECT conname
      FROM pg_catalog.pg_constraint
     WHERE conname IN (
       'crm_students_tenant_key',
       'crm_guardians_tenant_key',
       'crm_relationships_student_fk',
       'crm_relationships_guardian_fk'
     )
     ORDER BY conname;
  `);
  assert.deepEqual(tenantConstraints.rows.map(({ conname }) => conname), [
    "crm_guardians_tenant_key",
    "crm_relationships_guardian_fk",
    "crm_relationships_student_fk",
    "crm_students_tenant_key",
  ]);
}

async function seedOrganization(client: Client): Promise<void> {
  await client.query(`
    INSERT INTO identity_users (id, normalized_email, status)
    VALUES ('00000000-0000-4000-8000-000000000011', 'crm-founder@example.invalid', 'active');

    INSERT INTO access_organizations (id, display_name, status, created_by_user_id)
    VALUES (
      '10000000-0000-4000-8000-000000000011',
      'Tianxing CRM Release 1',
      'active',
      '00000000-0000-4000-8000-000000000011'
    );
  `);
}

async function assertReferralAndIdentityShape(client: Client): Promise<void> {
  await client.query(`
    INSERT INTO crm_referral_sources (
      id, organization_id, display_name, source_type, status
    ) VALUES
      (
        '11000000-0000-4000-8000-000000000001',
        '10000000-0000-4000-8000-000000000011',
        'Shared channel name',
        'partner',
        'active'
      ),
      (
        '11000000-0000-4000-8000-000000000002',
        '10000000-0000-4000-8000-000000000011',
        'Shared channel name',
        'partner',
        'active'
      );
  `);

  await client.query(`
    UPDATE crm_referral_sources
       SET display_name = 'Shared channel name v2',
           record_version = record_version + 1,
           updated_at = created_at + interval '2 minutes'
     WHERE id = '11000000-0000-4000-8000-000000000001';
  `);
  await expectSqlState(
    client,
    () =>
      client.query(`
        UPDATE crm_referral_sources
           SET display_name = 'Shared channel name v3',
               record_version = record_version + 1,
               updated_at = created_at + interval '1 minute'
         WHERE id = '11000000-0000-4000-8000-000000000001';
      `),
    "23514",
    "crm_referral_sources_updated_at_transition_check",
  );
  await expectSqlState(
    client,
    () =>
      client.query(`
        UPDATE crm_referral_sources
           SET display_name = 'Stale write',
               updated_at = updated_at + interval '1 minute'
         WHERE id = '11000000-0000-4000-8000-000000000001';
      `),
    "23514",
    "crm_referral_sources_record_version_transition_check",
  );
  await expectSqlState(
    client,
    () =>
      client.query(`
        DELETE FROM crm_referral_sources
         WHERE id = '11000000-0000-4000-8000-000000000001';
      `),
    "23514",
    "crm_referral_sources_delete_lifecycle_check",
  );

  const referralColumns = await client.query<{ column_name: string }>(`
    SELECT column_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'crm_referral_sources'
       AND column_name IN (
         'user_id', 'membership_id', 'role_binding_id', 'credential_id', 'session_id'
       );
  `);
  assert.deepEqual(referralColumns.rows, []);

  const forbiddenColumns = await client.query<{ column_name: string }>(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN ('crm_students', 'crm_guardians')
        AND column_name = ANY($1::text[])
      ORDER BY column_name`,
    [CRM_FORBIDDEN_LEGAL_ID_FIELDS],
  );
  assert.deepEqual(forbiddenColumns.rows, []);
}

async function assertDeferredPrimaryContactInvariant(client: Client): Promise<void> {
  await expectDeferredConstraint(
    client,
    () =>
      client.query(`
        INSERT INTO crm_students (
          id, organization_id, display_name, date_of_birth, contact_email, contact_phone, status
        ) VALUES (
          '12000000-0000-4000-8000-000000000099',
          '10000000-0000-4000-8000-000000000011',
          'Missing Primary',
          '2014-01-01',
          'shared@example.invalid',
          '+85200000000',
          'active'
        );
      `),
    "23514",
    "crm_students_current_primary_contact_check",
  );
}

async function seedSharedGuardianRelationships(client: Client): Promise<void> {
  await client.query(`
    INSERT INTO crm_guardians (
      id, organization_id, display_name, email, phone, status
    ) VALUES
      (
        '13000000-0000-4000-8000-000000000001',
        '10000000-0000-4000-8000-000000000011',
        'Shared Guardian',
        'shared@example.invalid',
        '+85200000000',
        'active'
      ),
      (
        '13000000-0000-4000-8000-000000000002',
        '10000000-0000-4000-8000-000000000011',
        'Shared Guardian',
        'shared@example.invalid',
        '+85200000000',
        'active'
      );

    INSERT INTO crm_students (
      id, organization_id, display_name, date_of_birth, contact_email, contact_phone, status
    ) VALUES
      (
        '12000000-0000-4000-8000-000000000001',
        '10000000-0000-4000-8000-000000000011',
        'Shared Student',
        '2014-01-01',
        'shared@example.invalid',
        '+85200000000',
        'active'
      ),
      (
        '12000000-0000-4000-8000-000000000002',
        '10000000-0000-4000-8000-000000000011',
        'Shared Student',
        '2014-01-01',
        'shared@example.invalid',
        '+85200000000',
        'active'
      );

    INSERT INTO crm_student_guardian_relationships (
      id,
      organization_id,
      student_id,
      guardian_id,
      relationship_type,
      is_legal_guardian,
      is_primary_contact,
      is_emergency_contact,
      is_billing_contact,
      notification_consent,
      starts_at
    ) VALUES
      (
        '14000000-0000-4000-8000-000000000001',
        '10000000-0000-4000-8000-000000000011',
        '12000000-0000-4000-8000-000000000001',
        '13000000-0000-4000-8000-000000000001',
        'parent', true, true, true, true, true,
        '2026-08-02T08:00:00Z'
      ),
      (
        '14000000-0000-4000-8000-000000000002',
        '10000000-0000-4000-8000-000000000011',
        '12000000-0000-4000-8000-000000000002',
        '13000000-0000-4000-8000-000000000001',
        'parent', true, true, true, true, true,
        '2026-08-02T08:00:00Z'
      );
  `);
  await forceDeferredChecks(client);
}

async function assertPrimaryHandoffAndHistory(client: Client): Promise<void> {
  await expectSqlState(
    client,
    () =>
      client.query(`
        INSERT INTO crm_student_guardian_relationships (
          id,
          organization_id,
          student_id,
          guardian_id,
          relationship_type,
          is_legal_guardian,
          is_primary_contact,
          is_emergency_contact,
          is_billing_contact,
          notification_consent,
          starts_at
        ) VALUES (
          '14000000-0000-4000-8000-000000000003',
          '10000000-0000-4000-8000-000000000011',
          '12000000-0000-4000-8000-000000000001',
          '13000000-0000-4000-8000-000000000002',
          'parent', true, true, true, true, true,
          '2026-08-02T08:01:00Z'
        );
      `),
    "23505",
    "crm_relationships_one_current_primary_idx",
  );

  await client.query(`
    UPDATE crm_student_guardian_relationships
       SET ends_at = transaction_timestamp(),
           ended_by_user_id = '00000000-0000-4000-8000-000000000011',
           end_reason = 'Primary contact handoff',
           record_version = record_version + 1,
           updated_at = transaction_timestamp()
     WHERE id = '14000000-0000-4000-8000-000000000001';

    INSERT INTO crm_student_guardian_relationships (
      id,
      organization_id,
      student_id,
      guardian_id,
      relationship_type,
      is_legal_guardian,
      is_primary_contact,
      is_emergency_contact,
      is_billing_contact,
      notification_consent,
      starts_at
    ) VALUES (
      '14000000-0000-4000-8000-000000000003',
      '10000000-0000-4000-8000-000000000011',
      '12000000-0000-4000-8000-000000000001',
      '13000000-0000-4000-8000-000000000002',
      'parent', true, true, true, true, true,
      transaction_timestamp()
    );
  `);
  await forceDeferredChecks(client);

  const history = await client.query<{ id: string; current: boolean }>(`
    SELECT id::text, ends_at IS NULL AS current
      FROM crm_student_guardian_relationships
     WHERE student_id = '12000000-0000-4000-8000-000000000001'
     ORDER BY starts_at;
  `);
  assert.deepEqual(history.rows, [
    { id: "14000000-0000-4000-8000-000000000001", current: false },
    { id: "14000000-0000-4000-8000-000000000003", current: true },
  ]);

  await expectSqlState(
    client,
    () =>
      client.query(`
        INSERT INTO crm_student_guardian_relationships (
          id,
          organization_id,
          student_id,
          guardian_id,
          relationship_type,
          is_legal_guardian,
          is_primary_contact,
          is_emergency_contact,
          is_billing_contact,
          notification_consent,
          starts_at
        ) VALUES (
          '14000000-0000-4000-8000-000000000005',
          '10000000-0000-4000-8000-000000000011',
          '12000000-0000-4000-8000-000000000001',
          '13000000-0000-4000-8000-000000000002',
          'parent', true, false, true, false, true,
          transaction_timestamp()
        );
      `),
    "23505",
    "crm_relationships_one_current_pair_idx",
  );

  await expectSqlState(
    client,
    () =>
      client.query(`
        UPDATE crm_student_guardian_relationships
           SET record_version = record_version + 1,
               updated_at = updated_at + interval '1 second'
         WHERE id = '14000000-0000-4000-8000-000000000001';
      `),
    "23514",
    "crm_relationships_immutable_history_check",
  );

  await expectSqlState(
    client,
    () =>
      client.query(`
        UPDATE crm_student_guardian_relationships
           SET relationship_type = 'corrected-parent',
               record_version = record_version + 1,
               updated_at = transaction_timestamp()
         WHERE id = '14000000-0000-4000-8000-000000000003';
      `),
    "23514",
    "crm_relationships_immutable_history_check",
  );
  await expectSqlState(
    client,
    () =>
      client.query(`
        DELETE FROM crm_student_guardian_relationships
         WHERE id = '14000000-0000-4000-8000-000000000001';
      `),
    "23514",
    "crm_relationships_delete_history_check",
  );
}

async function assertLifecycleAndPurgeGuards(client: Client): Promise<void> {
  await expectSqlState(
    client,
    () =>
      client.query(`
        UPDATE crm_students
           SET status = 'purged',
               display_name = NULL,
               date_of_birth = NULL,
               contact_email = NULL,
               contact_phone = NULL,
               deletion_requested_at = transaction_timestamp(),
               deletion_requested_by_user_id = '00000000-0000-4000-8000-000000000011',
               purge_approved_at = transaction_timestamp(),
               purge_approved_by_user_id = '00000000-0000-4000-8000-000000000011',
               purged_at = transaction_timestamp(),
               record_version = record_version + 1,
               updated_at = transaction_timestamp()
         WHERE id = '12000000-0000-4000-8000-000000000001';
      `),
    "23514",
    "crm_students_status_transition_check",
  );
  await expectSqlState(
    client,
    () =>
      client.query(`
        DELETE FROM crm_students
         WHERE id = '12000000-0000-4000-8000-000000000001';
      `),
    "23514",
    "crm_students_delete_lifecycle_check",
  );

  await client.query(`
    INSERT INTO crm_guardians (
      id, organization_id, display_name, email, phone, status
    ) VALUES (
      '13000000-0000-4000-8000-000000000003',
      '10000000-0000-4000-8000-000000000011',
      'Deletion Guardian',
      'delete@example.invalid',
      '+85211111111',
      'active'
    );

    INSERT INTO crm_students (
      id, organization_id, display_name, date_of_birth, contact_email, contact_phone, status
    ) VALUES (
      '12000000-0000-4000-8000-000000000003',
      '10000000-0000-4000-8000-000000000011',
      'Deletion Student',
      '2015-02-02',
      'delete@example.invalid',
      '+85211111111',
      'active'
    );

    INSERT INTO crm_student_guardian_relationships (
      id,
      organization_id,
      student_id,
      guardian_id,
      relationship_type,
      is_legal_guardian,
      is_primary_contact,
      is_emergency_contact,
      is_billing_contact,
      notification_consent,
      starts_at
    ) VALUES (
      '14000000-0000-4000-8000-000000000004',
      '10000000-0000-4000-8000-000000000011',
      '12000000-0000-4000-8000-000000000003',
      '13000000-0000-4000-8000-000000000003',
      'parent', true, true, true, true, true,
      '2026-08-02T08:00:00Z'
    );
  `);
  await forceDeferredChecks(client);

  await client.query(`
    UPDATE crm_student_guardian_relationships
       SET ends_at = transaction_timestamp(),
           ended_by_user_id = '00000000-0000-4000-8000-000000000011',
           end_reason = 'Student deletion review',
           record_version = record_version + 1,
           updated_at = transaction_timestamp()
     WHERE id = '14000000-0000-4000-8000-000000000004';

    UPDATE crm_students
       SET status = 'pending_delete',
           deletion_requested_at = transaction_timestamp(),
           deletion_requested_by_user_id = '00000000-0000-4000-8000-000000000011',
           deletion_reason = 'Client requested deletion review',
           record_version = record_version + 1,
           updated_at = transaction_timestamp()
     WHERE id = '12000000-0000-4000-8000-000000000003';
  `);
  await forceDeferredChecks(client);

  await expectSqlState(
    client,
    () =>
      client.query(`
        UPDATE crm_students
           SET status = 'purged',
               purge_approved_at = transaction_timestamp(),
               purge_approved_by_user_id = '00000000-0000-4000-8000-000000000011',
               purged_at = transaction_timestamp(),
               deletion_reason = NULL,
               record_version = record_version + 1,
               updated_at = transaction_timestamp()
         WHERE id = '12000000-0000-4000-8000-000000000003';
      `),
    "23514",
    "crm_students_purged_pii_check",
  );

  await client.query(`
    UPDATE crm_students
       SET status = 'purged',
           display_name = NULL,
           date_of_birth = NULL,
           contact_email = NULL,
           contact_phone = NULL,
           purge_approved_at = transaction_timestamp(),
           purge_approved_by_user_id = '00000000-0000-4000-8000-000000000011',
           purged_at = transaction_timestamp(),
           deletion_reason = NULL,
           record_version = record_version + 1,
           updated_at = transaction_timestamp()
     WHERE id = '12000000-0000-4000-8000-000000000003';
  `);

  await expectSqlState(
    client,
    () =>
      client.query(`
        UPDATE crm_students
           SET status = 'active',
               display_name = 'Restored without approval',
               record_version = record_version + 1,
               updated_at = transaction_timestamp()
         WHERE id = '12000000-0000-4000-8000-000000000003';
      `),
    "23514",
    "crm_students_status_transition_check",
  );

  await expectSqlState(
    client,
    async () => {
      await client.query(`
        UPDATE crm_guardians
           SET status = 'pending_delete',
               deletion_requested_at = transaction_timestamp(),
               deletion_requested_by_user_id = '00000000-0000-4000-8000-000000000011',
               deletion_reason = 'Guardian deletion review',
               record_version = record_version + 1,
               updated_at = transaction_timestamp()
         WHERE id = '13000000-0000-4000-8000-000000000002';

        UPDATE crm_guardians
           SET status = 'purged',
               display_name = NULL,
               email = NULL,
               phone = NULL,
               deletion_reason = NULL,
               purge_approved_at = transaction_timestamp(),
               purge_approved_by_user_id = '00000000-0000-4000-8000-000000000011',
               purged_at = transaction_timestamp(),
               record_version = record_version + 1,
               updated_at = transaction_timestamp()
         WHERE id = '13000000-0000-4000-8000-000000000002';
      `);
    },
    "23514",
    "crm_guardians_purge_current_relationship_check",
  );
}

async function forceDeferredChecks(client: Client): Promise<void> {
  await client.query("SET CONSTRAINTS ALL IMMEDIATE");
  await client.query("SET CONSTRAINTS ALL DEFERRED");
}

let expectedFailureSequence = 0;

async function expectSqlState(
  client: Client,
  operation: () => Promise<unknown>,
  expectedCode: string,
  expectedConstraint: string,
): Promise<void> {
  const savepoint = `crm_expected_failure_${expectedFailureSequence++}`;
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

async function expectDeferredConstraint(
  client: Client,
  operation: () => Promise<unknown>,
  expectedCode: string,
  expectedConstraint: string,
): Promise<void> {
  await expectSqlState(
    client,
    async () => {
      await operation();
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    },
    expectedCode,
    expectedConstraint,
  );
  await client.query("SET CONSTRAINTS ALL DEFERRED");
}
