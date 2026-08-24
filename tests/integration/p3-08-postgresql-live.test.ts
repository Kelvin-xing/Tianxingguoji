import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";

import { buildAtomicMutationEffects, buildAuditEvent, buildOutboxMessage } from "../../modules/audit/domain/contract.ts";
import { createPostgreSqlAdapter } from "../../modules/cases/infrastructure/postgresql.ts";
import { createProductionCaseCreationRepository } from "../../modules/cases/infrastructure/production-repository.ts";
import { createTenantTransactionRunner, type DatabasePool } from "../../modules/shared/infrastructure/db.ts";

const adminUrl = process.env.P3_ISOLATED_POSTGRES_ADMIN_URL;
const applicationUrl = process.env.P3_ISOLATED_POSTGRES_APP_URL;
const skipReason = !adminUrl || !applicationUrl
  ? "Explicit isolated PostgreSQL admin/application URLs were not supplied."
  : false;

const ids = Object.freeze({
  organization: "31000000-0000-4000-8000-000000000001",
  otherOrganization: "31000000-0000-4000-8000-000000000002",
  actor: "31000000-0000-4000-8000-000000000003",
  manifest: "31000000-0000-4000-8000-000000000004",
  membership: "31000000-0000-4000-8000-000000000005",
  founderBinding: "31000000-0000-4000-8000-000000000006",
  advisorBinding: "31000000-0000-4000-8000-000000000007",
  student: "31000000-0000-4000-8000-000000000008",
  serviceCase: "31000000-0000-4000-8000-000000000009",
  assessment: "31000000-0000-4000-8000-00000000000a",
  audit: "31000000-0000-4000-8000-00000000000b",
  outbox: "31000000-0000-4000-8000-00000000000c",
});

test("P3-08 retired live repository fails closed without a database mutation", { skip: skipReason }, async () => {
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  const application = new pg.Pool({ connectionString: applicationUrl, max: 3 });
  try {
    const migration = await readFile("db/migrations/202608130040_016_expand_application_predicates.sql", "utf8");
    const tail = await readFile("tests/fixtures/postgresql/p3-08-016-tail.sql", "utf8");
    for (const statement of tail.split(";").map((item) => item.trim()).filter(Boolean)) {
      assert.ok(migration.includes(`${statement};`));
      await admin.query(statement);
    }
    await seedAuthority(admin);
    await admin.query("INSERT INTO access_role_bindings (id, organization_id, membership_id, user_id, role, status) VALUES ($1,$2,$3,$4,'advisor','active') ON CONFLICT (id) DO NOTHING", [ids.advisorBinding, ids.organization, ids.membership, ids.actor]);

    const runner = createTenantTransactionRunner(application as unknown as DatabasePool);
    const repository = createProductionCaseCreationRepository(createPostgreSqlAdapter(runner));
    const input = createCaseInput();
    await assert.rejects(
      repository.createStudentAndK12Case(input),
      /CASE_CREATION_LEGACY_PATH_DISABLED/,
    );

    const counts = await admin.query<{ students: number; cases: number; assessments: number; audits: number; outbox: number; receipts: number }>(`
      SELECT
        (SELECT count(*)::int FROM crm_students WHERE id=$1) AS students,
        (SELECT count(*)::int FROM cases_service_cases WHERE id=$2) AS cases,
        (SELECT count(*)::int FROM cases_assessments WHERE id=$3) AS assessments,
        (SELECT count(*)::int FROM audit_events WHERE id=$4) AS audits,
        (SELECT count(*)::int FROM audit_outbox WHERE id=$5) AS outbox,
        (SELECT count(*)::int FROM shared_idempotency_records WHERE result_reference=$2::text AND state='completed') AS receipts`,
      [ids.student, ids.serviceCase, ids.assessment, ids.audit, ids.outbox]);
    assert.deepEqual(counts.rows[0], { students: 0, cases: 0, assessments: 0, audits: 0, outbox: 0, receipts: 0 });
  } finally {
    await application.end();
    await admin.end();
  }
});

async function seedAuthority(admin: pg.Pool): Promise<void> {
  await admin.query("INSERT INTO identity_users (id, normalized_email, status) VALUES ($1, $2, 'active') ON CONFLICT (id) DO NOTHING", [ids.actor, "p3-08-live@example.invalid"]);
  await admin.query("INSERT INTO access_organizations (id, display_name, status) VALUES ($1, 'Primary', 'active'), ($2, 'Other', 'disabled') ON CONFLICT (id) DO NOTHING", [ids.organization, ids.otherOrganization]);
  await admin.query("INSERT INTO access_organization_memberships (id, organization_id, user_id, status) VALUES ($1,$2,$3,'active') ON CONFLICT (id) DO NOTHING", [ids.membership, ids.organization, ids.actor]);
  await admin.query("INSERT INTO access_role_bindings (id, organization_id, membership_id, user_id, role, status) VALUES ($1,$2,$3,$4,'founder','active') ON CONFLICT (id) DO NOTHING", [ids.founderBinding, ids.organization, ids.membership, ids.actor]);
  await admin.query(`INSERT INTO cases_schema_manifests
    (id, application_type, composition_version, base_module_id, base_module_version,
     education_stage_module_id, education_stage_module_version, school_system_module_id,
     school_system_module_version, admission_route_module_id, admission_route_module_version,
     content_sha256, status)
    VALUES ($1,'k12','p3-live','base','1','stage','1','hk','1','s1','1',$2,'candidate')
    ON CONFLICT (id) DO NOTHING`, [ids.manifest, "a".repeat(64)]);
  await admin.query(`UPDATE cases_schema_manifests
    SET status='approved', approved_by_user_id=$2, approved_at=transaction_timestamp(),
        updated_at=transaction_timestamp()
    WHERE id=$1 AND status='candidate'`, [ids.manifest, ids.actor]);
}

function createCaseInput() {
  const occurredAt = "2026-08-13T12:00:00.000Z";
  const audit = buildAuditEvent({
    id: ids.audit, organizationId: ids.organization, actorUserId: ids.actor,
    actorKind: "user", eventType: "cases.service_case_created", eventVersion: 1,
    action: "create", resourceType: "ServiceCase", resourceId: ids.serviceCase,
    outcome: "succeeded", requestId: "p3-live-request", occurredAt,
    metadata: { record_version: 1, status: "signed", effect_type: "case.created" },
  });
  const outbox = buildOutboxMessage({
    id: ids.outbox, auditEventId: ids.audit, organizationId: ids.organization,
    aggregateType: "ServiceCase", aggregateId: ids.serviceCase,
    eventType: "cases.service_case_created", eventVersion: 1,
    idempotencyKey: "p3-live-outbox", requestId: "p3-live-request",
    payload: { aggregate_id: ids.serviceCase, request_id: "p3-live-request", effect_type: "case.created", record_version: 1, status: "signed" },
    availableAt: occurredAt, createdAt: occurredAt,
  });
  return {
    organizationId: ids.organization, actorUserId: ids.actor,
    student: { studentId: ids.student, displayName: "Synthetic Live Student", dateOfBirth: null, contactEmail: null, contactPhone: null, status: "active" as const },
    serviceCaseId: ids.serviceCase, assessmentId: ids.assessment, intakeYear: 2028,
    admissionType: "s1", caseNumber: "P3-LIVE-001", schemaManifestId: ids.manifest,
    requestId: "p3-live-request", idempotencyKey: "p3-live-case-create",
    requestHash: "b".repeat(64), createdAtMs: Date.parse(occurredAt),
    effects: buildAtomicMutationEffects({ audit, outbox }),
  };
}

test("P3-08 live PostgreSQL enforces RLS and narrow global predicates", { skip: skipReason }, async () => {
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  const application = new pg.Pool({ connectionString: applicationUrl, max: 2 });
  try {
    await admin.query("INSERT INTO identity_users (id, normalized_email, status) VALUES ($1, $2, 'active') ON CONFLICT (id) DO NOTHING", [ids.actor, "p3-08-live@example.invalid"]);
    await admin.query("INSERT INTO access_organizations (id, display_name, status) VALUES ($1, 'Primary', 'active'), ($2, 'Other', 'disabled') ON CONFLICT (id) DO NOTHING", [ids.organization, ids.otherOrganization]);
    await admin.query("INSERT INTO access_organization_memberships (id, organization_id, user_id, status) VALUES ($1,$2,$3,'active') ON CONFLICT (id) DO NOTHING", [ids.membership, ids.organization, ids.actor]);
    await admin.query("INSERT INTO access_role_bindings (id, organization_id, membership_id, user_id, role, status) VALUES ($1,$2,$3,$4,'founder','active') ON CONFLICT (id) DO NOTHING", [ids.founderBinding, ids.organization, ids.membership, ids.actor]);
    await admin.query(`INSERT INTO cases_schema_manifests
      (id, application_type, composition_version, base_module_id, base_module_version,
       education_stage_module_id, education_stage_module_version, school_system_module_id,
       school_system_module_version, admission_route_module_id, admission_route_module_version,
       content_sha256, status)
      VALUES ($1,'k12','p3-live','base','1','stage','1','hk','1','s1','1',$2,'candidate')
      ON CONFLICT (id) DO NOTHING`, [ids.manifest, "a".repeat(64)]);
    await admin.query(`UPDATE cases_schema_manifests
      SET status='approved', approved_by_user_id=$2, approved_at=transaction_timestamp(),
          updated_at=transaction_timestamp()
      WHERE id=$1 AND status='candidate'`, [ids.manifest, ids.actor]);

    const unscoped = await application.query("SELECT id FROM access_organization_memberships");
    assert.equal(unscoped.rowCount, 0);
    await assert.rejects(application.query("SELECT normalized_email FROM identity_users"), /permission denied/);

    const runner = createTenantTransactionRunner(application as unknown as DatabasePool);
    const adapter = createPostgreSqlAdapter(runner);
    const observed = await adapter.transaction(
      { organizationId: ids.organization, actorUserId: ids.actor },
      async (transaction) => ({
        organizations: await transaction.query<{ organization_id: string }>("SELECT organization_id FROM access_organization_memberships ORDER BY organization_id"),
        active: await transaction.query<{ active: boolean }>("SELECT identity_user_is_active($1::uuid) AS active", [ids.actor]),
        organizationActive: await transaction.query<{ active: boolean }>("SELECT access_organization_is_active($1::uuid) AS active", [ids.organization]),
        approved: await transaction.query<{ approved: boolean }>("SELECT cases_manifest_is_approved($1::uuid) AS approved", [ids.manifest]),
      }),
    );
    assert.deepEqual(observed.organizations.rows.map(({ organization_id }) => organization_id), [ids.organization]);
    assert.equal(observed.active.rows[0].active, true);
    assert.equal(observed.organizationActive.rows[0].active, true);
    assert.equal(observed.approved.rows[0].approved, true);
  } finally {
    await application.end();
    await admin.end();
  }
});
