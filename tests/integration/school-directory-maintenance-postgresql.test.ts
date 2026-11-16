import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { verifyCommittedOneRoleBaseline } from "../../scripts/db/generate-one-role-baseline.ts";
import { executeOneRoleBaselineRun, inspectOneRoleBaselineDatabase } from "../../scripts/db/run-one-role-baseline.ts";
import { seedNeonTestRelease1 } from "../../scripts/db/seed-neon-test-release1.ts";
import { NEON_TEST_ORGANIZATION, NEON_TEST_PRINCIPALS } from "../../scripts/db/neon-test-synthetic-fixture.ts";

import { Pool } from 'pg';
import { createTenantTransactionRunner, type DatabasePool } from '../../modules/shared/server.ts';
import { ManualDirectoryRepository } from '../../modules/schools/server.ts';
import { parseDirectoryCommand } from '../../modules/schools/public.ts';
function docker(args: string[], input?: string) {
  const r = spawnSync('docker', args, { input, encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
}
test('manual directory runtime permissions and mutations on PostgreSQL 17', { timeout: 180000 }, async t => {
  const name = `school-maintenance-${randomUUID()}`;
  let admin: Client | undefined, application: Client | undefined, pool: Pool | undefined;
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
    const target = {
      connectionString: `postgresql://tianxing_app@127.0.0.1:${port}/tianxing`, host: "127.0.0.1",
      port, database: "tianxing" as const, user: "tianxing_app" as const, ssl: false as const
    };
    application = new Client({ connectionString: target.connectionString });
    await application.connect();
    const baseline = await verifyCommittedOneRoleBaseline();
    await executeOneRoleBaselineRun({
      mode: "apply", target, build: baseline, dependencies: {
        inspect: async () => {
          const c = new Client({ connectionString: target.connectionString });
          await c.connect();
          try { return await inspectOneRoleBaselineDatabase(c); } finally { await c.end(); }
        },
        openExecutionConnection: async () => {
          const c = new Client({ connectionString: target.connectionString });
          await c.connect(); return { client: c, close: () => c.end() };
        },
      }
    });
    assert.equal((await seedNeonTestRelease1(target, "apply")).status, "pass");
    admin = new Client({ host: "127.0.0.1", port, database: "tianxing", user: "postgres" });
    await admin.connect();

    // Four trial levels on existing synthetic memberships; no second organization.
    await admin.query('BEGIN');
    await admin.query("SELECT set_config('app.organization_id',$1,true),set_config('app.actor_user_id',$2,true)", [NEON_TEST_ORGANIZATION.id, NEON_TEST_PRINCIPALS[0]!.userId]);
    const levels = ['founder', 'l1', 'l2', 'l3'];
    const actors: { organizationId: string; actorUserId: string }[] = [{ organizationId: NEON_TEST_ORGANIZATION.id, actorUserId: NEON_TEST_PRINCIPALS[0]!.userId }];
    for (const [i, level] of levels.entries()) {
      const userId = i === 0 ? actors[0]!.actorUserId : randomUUID(), membershipId = i === 0 ? NEON_TEST_PRINCIPALS[0]!.membershipId : randomUUID();
      if (i > 0) {
        await admin.query("INSERT INTO identity_users(id,normalized_email,status,activated_at,created_by_user_id) VALUES($1,$2,'active',now(),$3)", [userId, `${level}@directory.invalid`, actors[0]!.actorUserId]);
        await admin.query("INSERT INTO access_organization_memberships(id,organization_id,user_id,status,activated_at,created_by_user_id) VALUES($1,$2,$3,'active',now(),$4)", [membershipId, NEON_TEST_ORGANIZATION.id, userId, actors[0]!.actorUserId]);
        await admin.query("INSERT INTO access_employee_profiles(membership_id,organization_id,display_name,employment_type) VALUES($1,$2,$3,$4)", [membershipId, NEON_TEST_ORGANIZATION.id, `Synthetic ${level}`, level === 'l3' ? 'PART_TIME' : 'FULL_TIME']);
        await admin.query("INSERT INTO access_role_bindings(id,organization_id,membership_id,user_id,role,status,created_by_user_id) VALUES($1,$2,$3,$4,$5,'active',$6)", [randomUUID(), NEON_TEST_ORGANIZATION.id, membershipId, userId, level, actors[0]!.actorUserId]);
        actors.push({ organizationId: NEON_TEST_ORGANIZATION.id, actorUserId: userId });
      }
      await admin.query(`INSERT INTO access_trial_members(membership_id,organization_id,user_id,level,categories,status,created_by_user_id,updated_by_user_id)
        VALUES($1,$2,$3,$4,$5,'active',$6,$6)`, [membershipId, NEON_TEST_ORGANIZATION.id, userId, level, level === 'l2' ? ['local_school'] : [], actors[0]!.actorUserId]);
    }
    await admin.query('COMMIT');
    pool = new Pool({ connectionString: target.connectionString });
    const runner = createTenantTransactionRunner(pool as unknown as DatabasePool, { expectedLoginUser: 'tianxing_app' });
    const repo = new ManualDirectoryRepository(runner);
    let id = '';
    await t.test('all four levels can create, read and modify without approval; idempotent create', async () => {
      for (const a of actors) {
        const key = randomUUID(); const command = parseDirectoryCommand({ action: 'create', nameZh: '合成目錄測試', nameEn: '' });
        id = await repo.mutate(a, command, key);
        assert.equal(await repo.mutate(a, command, key), id);
        const d = await repo.read(a, id); assert.equal(d.campuses.length, 1); assert.equal(d.school.edb_number, null);
        await repo.mutate(a, { action: 'field', schoolId: id, version: d.school.record_version, field: 'school_level', value: '合成學段' }, randomUUID());
        const apply = async (extra: Record<string, unknown>) => { const latest = await repo.read(a, id); return repo.mutate(a, parseDirectoryCommand({ schoolId: id, version: latest.school.record_version, ...extra }), randomUUID()); };
        await apply({ action: 'field', field: 'phone', value: '5550001' });
        await apply({ action: 'addCampus' }); await apply({ action: 'split', field: 'phone' });
        let latest = await repo.read(a, id); const added = latest.campuses[1]!.id;
        await apply({ action: 'field', field: 'phone', value: '5550002', campusId: added });
        latest = await repo.read(a, id); const history = latest.history.find(h => h.new_value === '5550002')!;
        await apply({ action: 'restore', historyId: history.id });
        assert.equal((await repo.read(a, id)).campuses.find(c => c.id === added)!.fields.phone, '5550001');
        await apply({ action: 'closed', value: true }); await apply({ action: 'closed', value: false });
        await apply({ action: 'deleteCampus', campusId: added });
        assert.equal((await repo.read(a, id)).campuses.length, 1);

      }
    });
    const a = actors[0]!;
    const run = async (extra: Record<string, unknown>) => { const d = await repo.read(a, id); return repo.mutate(a, parseDirectoryCommand({ schoolId: id, version: d.school.record_version, ...extra }), randomUUID()); };
    await t.test('both names empty rollback, and legacy non-trial account denied', async () => {
      await assert.rejects(run({ action: 'field', field: 'school_name_zh', value: null }));
      assert.equal((await repo.read(a, id)).school.fields.school_name_zh, '合成目錄測試');
      await assert.rejects(repo.list({ organizationId: NEON_TEST_ORGANIZATION.id, actorUserId: NEON_TEST_PRINCIPALS[4]!.userId }));
    });
    await t.test('shared field, added campus, split and field isolation', async () => {
      await run({ action: 'field', field: 'phone', value: '5551000' });
      await run({ action: 'addCampus' });
      let d = await repo.read(a, id); assert.equal(d.campuses.length, 2); assert.ok(d.campuses.every(c => c.fields.phone === '5551000'));
      await run({ action: 'split', field: 'phone' }); d = await repo.read(a, id);
      await run({ action: 'field', field: 'phone', value: '5552000', campusId: d.campuses[0]!.id });
      d = await repo.read(a, id); assert.equal(d.campuses[0]!.fields.phone, '5552000'); assert.equal(d.campuses[1]!.fields.phone, '5551000');
    });
    await t.test('restoring one field keeps others and retains actor/time/history', async () => {
      let d = await repo.read(a, id); const h = d.history.find(h => h.field_key === 'phone' && h.new_value === '5552000')!; assert.ok(h.actor); assert.ok(h.occurred_at);
      await run({ action: 'restore', historyId: h.id }); d = await repo.read(a, id);
      assert.equal(d.campuses[0]!.fields.phone, '5551000'); assert.equal(d.school.fields.school_level, '合成學段');
      const source = (await admin!.query("SELECT source FROM schools_directory_history WHERE school_id=$1 AND source->>'operation'='restore' ORDER BY id DESC LIMIT 1", [id])).rows[0].source; assert.equal(source.restoredHistoryId, h.id);
    });
    await t.test('school-wide concurrency conflict between two actors', async () => {
      const d = await repo.read(a, id); const command = parseDirectoryCommand({ action: 'closed', schoolId: id, version: d.school.record_version, value: true });
      const results = await Promise.allSettled([repo.mutate(a, command, randomUUID()), repo.mutate(actors[3]!, command, randomUUID())]);
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(results.filter(r => r.status === 'rejected').length, 1);
      assert.equal((await repo.read(a, id)).school.is_closed, true);
    });
    await t.test('manual campus soft-delete retains history, last campus cannot be deleted', async () => {
      let d = await repo.read(a, id); const removed = d.campuses[0]!.id;
      await run({ action: 'deleteCampus', campusId: removed }); d = await repo.read(a, id);
      assert.ok(d.history.some(h => h.campus_id === removed)); assert.equal(d.campuses.length, 1);
      await assert.rejects(run({ action: 'deleteCampus', campusId: d.campuses[0]!.id }));
    });
    await t.test('group save changes two fields with two history entries, and rolls back the entire group on conflict or invalid names', async () => {
      let d = await repo.read(a, id);
      const before = d.history.length;
      await run({ action: 'fields', changes: [{ field: 'school_name_zh', value: null }, { field: 'school_name_en', value: 'Synthetic UI group' }] });
      d = await repo.read(a, id);
      assert.equal(d.school.fields.school_name_zh, null);
      assert.equal(d.school.fields.school_name_en, 'Synthetic UI group');
      assert.equal(d.history.length - before, 2);
      const stale = d.school.record_version;
      await run({ action: 'field', field: 'school_level', value: '中學' });
      await assert.rejects(repo.mutate(a, { action: 'fields', schoolId: id, version: stale, changes: [{ field: 'school_name_en', value: 'must not persist' }] }, randomUUID()));
      await assert.rejects(run({ action: 'fields', changes: [{ field: 'school_name_en', value: null }, { field: 'tuition_info', value: 'must roll back' }] }));
      d = await repo.read(a, id);
      assert.equal(d.school.fields.school_name_en, 'Synthetic UI group');
      assert.equal(d.school.fields.tuition_info, undefined);
    });
    await t.test('pagination and combined filters operate before limiting results', async () => {
      await run({ action: 'field', field: 'district', value: '中西區' });
      const first = await repo.list(a, { search: '', level: '', district: '', page: 1, pageSize: 2 });
      const second = await repo.list(a, { search: '', level: '', district: '', page: 2, pageSize: 2 });
      assert.equal(first.total, 4);
      assert.equal(first.items.length, 2);
      assert.equal(second.items.length, 2);
      assert.ok(!first.items.some(x => second.items.some(y => x.id === y.id)));
      const filtered = await repo.list(a, { search: 'SYNTHETIC UI', level: '中學', district: '中西區', page: 1, pageSize: 2 });
      assert.equal(filtered.total, 1);
      assert.equal(filtered.items[0]!.id, id);
      assert.deepEqual(filtered.items[0]!.districts, ['中西區']);
      assert.equal((await repo.list(a, { search: 'not present', level: '', district: '', page: 1, pageSize: 2 })).total, 0);
    });
    await t.test('campus fallback number survives deleting another campus and adding a new campus', async () => {
      await run({ action: 'addCampus' });
      let d = await repo.read(a, id);
      const survivor = d.campuses[1]!;
      const number = survivor.display_number;
      await run({ action: 'deleteCampus', campusId: d.campuses[0]!.id });
      await run({ action: 'addCampus' });
      d = await repo.read(a, id);
      assert.equal(d.campuses.find(c => c.id === survivor.id)!.display_number, number);
      assert.equal(d.campuses[1]!.display_number, number + 1);
    });
    await t.test('missing/wrong organization and inactive principal cannot read', async () => {
      assert.equal((await application!.query('SELECT * FROM schools_directory_schools')).rowCount, 0);
      await assert.rejects(repo.list({ ...a, organizationId: randomUUID() }));
      await admin!.query('BEGIN'); await admin!.query("SELECT set_config('app.organization_id',$1,true),set_config('app.actor_user_id',$2,true)", [a.organizationId, a.actorUserId]);
      await admin!.query("UPDATE access_trial_members SET status='disabled',record_version=record_version+1 WHERE user_id=$1", [actors[3]!.actorUserId]); await admin!.query('COMMIT');
      await assert.rejects(repo.list(actors[3]!));
    });
  } finally { await pool?.end(); await application?.end(); await admin?.end(); docker(['rm', '--force', name]); }
});
