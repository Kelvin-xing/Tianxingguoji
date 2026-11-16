import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { verifyCommittedOneRoleBaseline } from "../../scripts/db/generate-one-role-baseline.ts";
import { executeOneRoleBaselineRun, inspectOneRoleBaselineDatabase } from "../../scripts/db/run-one-role-baseline.ts";
import { seedNeonTestRelease1 } from "../../scripts/db/seed-neon-test-release1.ts";
import { NEON_TEST_ORGANIZATION, NEON_TEST_PRINCIPALS, NEON_TEST_STUDENTS, NEON_TEST_MANIFEST_ID } from "../../scripts/db/neon-test-synthetic-fixture.ts";
import { DIRECTORY_CAMPUS_FIELDS } from "../../modules/schools/domain/directory-structure.ts";
import { DirectoryStructureStore } from "../../modules/schools/infrastructure/directory-structure-store.ts";

const migration = new URL("../../db/migrations/202611150010_076_expand_school_directory_structure.sql", import.meta.url);
function docker(args: string[], input?: string) {
  const r = spawnSync("docker", args, { input, encoding: "utf8", timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

test("directory constraints, preserved legacy pins and reversible PostgreSQL 17 migration", { timeout: 180_000 }, async t => {
  const name = `school-directory-${randomUUID()}`;
  let admin: Client | undefined;
  let application: Client | undefined;
  const up = await readFile(migration, "utf8");
  // Test-only reversal in a disposable synthetic database, never an installer.
  const down = `DROP TABLE schools_directory_history;
    DROP TABLE schools_directory_field_modes;
    DROP TABLE schools_directory_campuses;
    DROP TABLE schools_directory_schools;
    DROP FUNCTION schools_directory_check_shape();
    DROP FUNCTION schools_directory_mode_guard();
    DROP FUNCTION schools_directory_write_guard();
    DROP FUNCTION schools_directory_no_delete();
    DROP FUNCTION schools_directory_history_guard();
    DROP FUNCTION schools_directory_valid_fields(jsonb,text[]);`;
  try {
    docker(["run", "--detach", "--pull=never", "--name", name, "--tmpfs", "/var/lib/postgresql/data:rw,size=512m",
      "--env", "POSTGRES_HOST_AUTH_METHOD=trust", "--publish", "127.0.0.1::5432", "postgres:17.10-alpine3.24"]);
    for (let i = 0; i < 60; i++) {
      const probe = spawnSync("docker", ["exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"], { stdio: "ignore" });
      if (probe.status === 0) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    docker(["exec", "-i", name, "psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres"],
      "CREATE ROLE tianxing_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS; CREATE DATABASE tianxing OWNER tianxing_app;");
    const match = docker(["port", name, "5432/tcp"]).match(/^127\.0\.0\.1:(\d+)$/);
    assert.ok(match);
    const port = Number(match[1]);
    const target = { connectionString: `postgresql://tianxing_app@127.0.0.1:${port}/tianxing`, host: "127.0.0.1",
      port, database: "tianxing" as const, user: "tianxing_app" as const, ssl: false as const };
    application = new Client({ connectionString: target.connectionString });
    await application.connect();
    const baseline = await verifyCommittedOneRoleBaseline();
    await executeOneRoleBaselineRun({ mode: "apply", target, build: baseline, dependencies: {
      inspect: async () => {
        const c = new Client({ connectionString: target.connectionString });
        await c.connect();
        try { return await inspectOneRoleBaselineDatabase(c); } finally { await c.end(); }
      },
      openExecutionConnection: async () => {
        const c = new Client({ connectionString: target.connectionString });
        await c.connect(); return { client: c, close: () => c.end() };
      },
    } });
    assert.equal((await seedNeonTestRelease1(target, "apply")).status, "pass");
    admin = new Client({ host: "127.0.0.1", port, database: "tianxing", user: "postgres" });
    await admin.connect();
    const client = admin;
    const legacy = async () => (await client.query(`SELECT md5(coalesce(jsonb_agg(t ORDER BY id)::text,'[]')) AS digest FROM cases_school_targets t`)).rows[0].digest;
    // A real synthetic legacy application pin makes the preservation check non-vacuous.
    const legacyCase = randomUUID(), legacyRevision = randomUUID();
    const advisor = NEON_TEST_PRINCIPALS[2]!;
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.organization_id',$1,true),set_config('app.actor_user_id',$2,true)",
      [NEON_TEST_ORGANIZATION.id, advisor.userId]);
    await client.query(`INSERT INTO cases_service_cases
      (id,organization_id,student_id,case_number,application_type,intake_year,admission_type,
       primary_role_binding_id,primary_membership_id,primary_user_id,primary_role,stage,
       workflow_status,record_version,current_primary_advisor_assignment_id,business_category)
      VALUES ($1,$2,$3,$4,'k12',2090,'transfer',$5,$6,$7,'advisor','signed','active',1,$8,'local_school')`,
    [legacyCase,NEON_TEST_ORGANIZATION.id,NEON_TEST_STUDENTS[0]!.id,`DIRECTORY-${legacyCase}`,
      advisor.roleBindingId,advisor.membershipId,advisor.userId,randomUUID()]);
    await client.query(`INSERT INTO cases_primary_advisor_assignments
      (id,organization_id,service_case_id,advisor_role_binding_id,membership_id,advisor_user_id,advisor_role,starts_at,assignment_reason)
      SELECT current_primary_advisor_assignment_id,organization_id,id,primary_role_binding_id,primary_membership_id,
      primary_user_id,'advisor',created_at,'synthetic_directory_pin' FROM cases_service_cases WHERE id=$1`, [legacyCase]);
    const pinned = (await client.query(`INSERT INTO schools_resolved_revisions
      (id,organization_id,school_id,base_snapshot_id,overlay_revision_id,resolution_sha256,fields_json,provenance_json,conflicts_json)
      SELECT $1,organization_id,school_id,snapshot_id,NULL,record_sha256,fields_json,provenance_json,'[]'::jsonb
      FROM schools_snapshot_records ORDER BY id LIMIT 1 RETURNING school_id,resolution_sha256`, [legacyRevision])).rows[0];
    assert.ok(pinned);
    await client.query(`INSERT INTO cases_school_targets
      (id,organization_id,service_case_id,school_id,intake_year,admission_type,state,pinned_resolved_revision_id,pinned_resolution_sha256)
      VALUES($1,$2,$3,$4,2090,'transfer','candidate',$5,$6)`,
    [randomUUID(),NEON_TEST_ORGANIZATION.id,legacyCase,pinned.school_id,legacyRevision,pinned.resolution_sha256]);
    await client.query(`INSERT INTO cases_assessments(id,organization_id,service_case_id,manifest_id,status,record_version)
      VALUES($1,$2,$3,$4,'draft',1)`,[randomUUID(),NEON_TEST_ORGANIZATION.id,legacyCase,NEON_TEST_MANIFEST_ID]);
    const advanced = await client.query("SELECT * FROM cases_advance_new_service_case($1,'advisor',$2,transaction_timestamp())",[legacyCase,randomUUID()]);
    assert.equal(advanced.rows[0].decision,"allowed");
    await client.query("COMMIT");
    assert.equal((await client.query("SELECT count(*)::int n FROM cases_school_targets WHERE pinned_resolved_revision_id IS NOT NULL")).rows[0].n, 1);
    const legacyBefore = await legacy();
    assert.equal((await client.query("SELECT count(*)::int n FROM schools_directory_schools")).rows[0].n, 0);
    const org = NEON_TEST_ORGANIZATION.id;
    const actor = NEON_TEST_PRINCIPALS[0]!.userId;
    const school = randomUUID(), campus = randomUUID(), otherCampus = randomUUID();
    const context = async () => new DirectoryStructureStore(client).context({ organizationId: org, actorId: actor,
      source: { kind: "synthetic-manual" }, occurredAt: "2026-11-15T12:00:00Z" });
    const tx = async (fn: (store: DirectoryStructureStore) => Promise<void>) => {
      await client.query("BEGIN");
      try { await context(); await fn(new DirectoryStructureStore(client)); await client.query("COMMIT"); }
      catch (error) { await client.query("ROLLBACK"); throw error; }
    };
    const schoolVersion = async () => Number((await client.query("SELECT record_version FROM schools_directory_schools WHERE id=$1", [school])).rows[0].record_version);
    const campusVersion = async () => Number((await client.query("SELECT record_version FROM schools_directory_campuses WHERE id=$1", [campus])).rows[0].record_version);
    const create = (id: string, cid: string, fields: object, edb: string | null = null, origin: "edb" | "manual" = "manual") => tx(async store => {
      await store.create({ id, campusId: cid, organizationId: org, edbNumber: edb, origin, campusOrigin: origin,
        fields: fields as Record<string, string>, campusFields: { phone: "111", address: "合成地址" }, sharedFields: [...DIRECTORY_CAMPUS_FIELDS] });
    });
    await t.test("rejects both names empty and accepts unknown EDB with one name", async () => {
      await assert.rejects(create(randomUUID(), randomUUID(), { school_name_zh: null, school_name_en: " " }));
      await create(school, campus, { school_name_zh: "合成学校", school_name_en: null });
      assert.equal((await client.query("SELECT edb_number FROM schools_directory_schools WHERE id=$1", [school])).rows[0].edb_number, null);
    });
    await t.test("EDB six digits are unique, and campuses never create a school", async () => {
      await create(randomUUID(), randomUUID(), { school_name_en: "Synthetic EDB" }, "123456", "edb");
      await assert.rejects(create(randomUUID(), randomUUID(), { school_name_en: "Duplicate" }, "123456", "edb"));
      await assert.rejects(create(randomUUID(), randomUUID(), { school_name_en: "Bad" }, "123", "edb"));
      await tx(async store => store.addCampus({ id: otherCampus, schoolId: school, organizationId: org,
        origin: "manual", fields: { phone: "111", address: "合成地址" } }));
      assert.equal((await client.query("SELECT count(*)::int n FROM schools_directory_schools")).rows[0].n, 2);
    });
    await t.test("shared change affects all campuses, split isolates fields and retains raw evidence", async () => {
      await tx(async store => store.setSharedField(school, "phone", "222", await schoolVersion()));
      assert.deepEqual((await client.query("SELECT fields->>'phone' value FROM schools_directory_campuses WHERE school_id=$1", [school])).rows.map(r => r.value), ["222", "222"]);
      await assert.rejects(tx(async store => store.setCampusField(campus, "phone", "333", await campusVersion())));
      await tx(async store => {
        await store.splitField(school, "phone", await schoolVersion());
        await store.setCampusField(campus, "phone", "333", await campusVersion());
      });
      assert.equal((await client.query("SELECT fields->>'phone' v FROM schools_directory_campuses WHERE id=$1", [otherCampus])).rows[0].v, "222");
      await tx(async store => {
        await store.splitField(school, "official_website", await schoolVersion());
        await store.setCampusField(campus, "official_website", "http://www.synthetic.invalid/", await campusVersion());
      });
      assert.equal((await client.query("SELECT fields->>'official_website' v FROM schools_directory_campuses WHERE id=$1", [campus])).rows[0].v, "http://www.synthetic.invalid/");
    });
    await t.test("shared restore updates only the common field across campuses", async () => {
      await tx(async store => store.setSharedField(school,"fax","synthetic-fax",await schoolVersion()));
      const h = (await client.query("SELECT id FROM schools_directory_history WHERE campus_id=$1 AND field_key='fax' ORDER BY id DESC LIMIT 1",[campus])).rows[0].id;
      await tx(async store => store.restoreField(h,await campusVersion(),await schoolVersion()));
      const values=(await client.query("SELECT fields->'fax' v,fields->>'address' address FROM schools_directory_campuses WHERE school_id=$1",[school])).rows;
      assert.ok(values.every(r=>r.v===null && r.address==="合成地址"));
    });
    await t.test("field ownership rejects misplaced fields and a school cannot commit without a campus", async () => {
      await assert.rejects(create(randomUUID(),randomUUID(),{school_name_en:"Synthetic",phone:"wrong scope"}));
      await assert.rejects(tx(async () => {await client.query(`INSERT INTO schools_directory_schools
        (id,organization_id,edb_number,origin,fields) VALUES ($1,$2,NULL,'manual','{"school_name_en":"No campus"}')`,[randomUUID(),org]);}));
      await assert.rejects(tx(async store=>store.setSchoolField(school,"is_sen","unknown",await schoolVersion())));
    });
    await t.test("field restore changes only selected value, versions and complete immutable history", async () => {
      const h = (await client.query(`SELECT id FROM schools_directory_history WHERE campus_id=$1 AND field_key='phone' AND new_value='"333"'::jsonb`, [campus])).rows[0].id;
      await tx(async store => store.restoreField(h, await campusVersion()));
      const row = (await client.query("SELECT fields FROM schools_directory_campuses WHERE id=$1", [campus])).rows[0];
      assert.equal(row.fields.phone, "222"); assert.equal(row.fields.address, "合成地址");
      assert.equal(row.fields.official_website, "http://www.synthetic.invalid/");
      await assert.rejects(tx(async store => store.setSchoolField(school, "school_level", "secondary", 1)));
      const history = (await client.query("SELECT * FROM schools_directory_history WHERE campus_id=$1 AND field_key='phone' ORDER BY id DESC LIMIT 1", [campus])).rows[0];
      assert.equal(history.actor_user_id, actor); assert.equal(history.old_value, "333"); assert.equal(history.new_value, "222");
      assert.ok(history.occurred_at); assert.ok(history.record_version); assert.ok(history.source);
      await assert.rejects(client.query("DELETE FROM schools_directory_history WHERE id=$1", [h]));
    });
    await t.test("unknown values and closed information do not touch any legacy reference", async () => {
      await tx(async store => store.setSchoolField(school, "is_sen", null, await schoolVersion()));
      await tx(async () => { await client.query("UPDATE schools_directory_schools SET is_closed=true,record_version=record_version+1 WHERE id=$1", [school]); });
      assert.equal((await client.query("SELECT is_closed FROM schools_directory_schools WHERE id=$1", [school])).rows[0].is_closed, true);
      assert.equal(await legacy(), legacyBefore);
      const closeHistory=(await client.query("SELECT id FROM schools_directory_history WHERE school_id=$1 AND field_key='is_closed' AND new_value='true'::jsonb",[school])).rows[0].id;
      await tx(async store=>store.restoreField(closeHistory,await schoolVersion()));
      assert.equal((await client.query("SELECT is_closed FROM schools_directory_schools WHERE id=$1",[school])).rows[0].is_closed,null);
      await assert.rejects(tx(async store => store.setCampusField(campus, "phone", true, await campusVersion())));
    });
    await t.test("audit failure rolls back the field mutation and cross-organization context is rejected", async () => {
      const before=(await client.query("SELECT fields,record_version FROM schools_directory_schools WHERE id=$1",[school])).rows[0];
      await assert.rejects(tx(async store=>{
        await store.context({organizationId:org,actorId:actor,source:[],occurredAt:"2026-11-15T12:00:00Z"});
        await store.setSchoolField(school,"school_level","synthetic-change",Number(before.record_version));
      }));
      await assert.rejects(tx(async store=>{
        await store.context({organizationId:randomUUID(),actorId:actor,source:{kind:"synthetic"},occurredAt:"2026-11-15T12:00:00Z"});
        await store.setSchoolField(school,"school_level","wrong-organization",Number(before.record_version));
      }));
      assert.deepEqual((await client.query("SELECT fields,record_version FROM schools_directory_schools WHERE id=$1",[school])).rows[0],before);
    });
    await t.test("deleting manual campus keeps history, rejects EDB and last campus", async () => {
      const n = Number((await client.query("SELECT count(*) n FROM schools_directory_history WHERE campus_id=$1", [campus])).rows[0].n);
      await tx(async store => store.deleteCampus(campus, await campusVersion()));
      assert.ok(Number((await client.query("SELECT count(*) n FROM schools_directory_history WHERE campus_id=$1", [campus])).rows[0].n) > n);
      await assert.rejects(tx(async store => store.deleteCampus(otherCampus, Number((await client.query("SELECT record_version FROM schools_directory_campuses WHERE id=$1",[otherCampus])).rows[0].record_version))));
      const edbCampus = (await client.query("SELECT id,record_version FROM schools_directory_campuses WHERE origin='edb'")).rows[0];
      await assert.rejects(tx(async store => store.deleteCampus(edbCampus.id, Number(edbCampus.record_version))));
      await assert.rejects(client.query("DELETE FROM schools_directory_campuses WHERE id=$1", [campus]));
    });
    await t.test("concurrent deletes cannot remove both remaining manual campuses", async () => {
      const id=randomUUID(),a=randomUUID(),b=randomUUID();
      await create(id,a,{school_name_en:"Concurrent synthetic"});
      await tx(async store=>store.addCampus({id:b,schoolId:id,organizationId:org,origin:"manual",fields:{phone:"111",address:"合成地址"}}));
      const attempt=async (cid:string)=>{
        const c=new Client({host:"127.0.0.1",port,database:"tianxing",user:"postgres"});await c.connect();
        try {await c.query("BEGIN");const store=new DirectoryStructureStore(c);
          await store.context({organizationId:org,actorId:actor,source:{kind:"synthetic-manual"},occurredAt:"2026-11-15T12:00:00Z"});
          await store.deleteCampus(cid,1);await c.query("COMMIT");
        } catch(e){await c.query("ROLLBACK");throw e;} finally {await c.end();}
      };
      const outcomes=await Promise.allSettled([attempt(a),attempt(b)]);
      assert.equal(outcomes.filter(x=>x.status==="fulfilled").length,1);
      assert.equal(outcomes.filter(x=>x.status==="rejected").length,1);
      assert.equal((await client.query("SELECT count(*)::int n FROM schools_directory_campuses WHERE school_id=$1 AND deleted_at IS NULL",[id])).rows[0].n,1);
    });
    await t.test("missing actor context is denied and forced RLS hides owner rows without widening grants", async () => {
      await assert.rejects(client.query("UPDATE schools_directory_schools SET record_version=record_version+1 WHERE id=$1", [school]));
      // The canonical baseline makes this role the table owner. FORCE RLS with
      // no policy must expose zero rows rather than a table-ACL error.
      assert.equal((await application!.query("SELECT * FROM schools_directory_schools")).rowCount, 0);
      assert.equal((await client.query("SELECT count(*)::int n FROM schools_directory_schools")).rows[0].n > 0, true);
      assert.equal((await client.query("SELECT relforcerowsecurity FROM pg_class WHERE oid='schools_directory_schools'::regclass")).rows[0].relforcerowsecurity, true);
      assert.equal((await client.query("SELECT count(*)::int n FROM pg_policies WHERE tablename LIKE 'schools_directory_%'")).rows[0].n, 0);
    });
    await t.test("rollback removes only new storage; reapply is empty and legacy pins unchanged", async () => {
      await client.query(down!);
      assert.equal((await client.query("SELECT to_regclass('schools_directory_schools') AS t")).rows[0].t, null);
      assert.equal(await legacy(), legacyBefore);
      await client.query(up!);
      assert.equal((await client.query("SELECT count(*)::int n FROM schools_directory_schools")).rows[0].n, 0);
      await client.query(down!);
    });
    await t.test("application owner installs the migration and restores shared REFERENCES privileges", async () => {
      const privileges = async () => (await application!.query(`SELECT
        has_table_privilege(current_user,'access_organizations','REFERENCES') organization,
        has_table_privilege(current_user,'identity_users','REFERENCES') identity`)).rows[0];
      const before = await privileges();
      assert.deepEqual(before, { organization: false, identity: false });
      await application!.query("BEGIN");
      try {
        await application!.query(up);
        assert.deepEqual(await privileges(), before);
        await application!.query("COMMIT");
      } catch (error) { await application!.query("ROLLBACK"); throw error; }
      assert.deepEqual(await privileges(), before);
      assert.equal((await client.query("SELECT count(*)::int n FROM schools_directory_schools")).rows[0].n,0);
      assert.equal(await legacy(), legacyBefore);
      // Owner-created tables/functions must be reversed as their owner too.
      await application!.query(down);
    });
  } finally {
    await application?.end(); await admin?.end();
    docker(["rm", "--force", name]);
  }
});
