import "server-only";
import { randomUUID } from 'node:crypto';
import { loadTrialPrincipal } from '../../access/server.ts';
import { hashRequestPayload } from '../../shared/public.ts';
import { runIdempotentTransaction, type TenantTransaction, type TenantTransactionRunner } from '../../shared/server.ts';
import { DirectoryStructureStore } from './directory-structure-store.ts';
import { DIRECTORY_CAMPUS_FIELDS, DIRECTORY_SCHOOL_FIELDS, DirectoryError, directoryValuesEqual, type DirectoryCommand, type DirectoryDetail, type ManualDirectorySchool, type DirectoryCampus, type DirectoryHistory, type DirectoryListQuery, type DirectoryListResult } from '../domain/manual-directory.ts';
import type { DirectoryCampusField, DirectorySchoolField } from '../domain/directory-structure.ts';
type Actor = { organizationId: string; actorUserId: string };
function adapt(tx: TenantTransaction) {
  return {
    async query<R extends Record<string, unknown>>(text: string, values?: readonly unknown[]) {
      const r = await tx.query<R>({ text, values });
      return { rows: [...r.rows], rowCount: r.rowCount ?? r.rows.length };
    }
  };
}
async function authorize(tx: TenantTransaction, actor: Actor) {
  const principal = await loadTrialPrincipal(adapt(tx), { organizationId: actor.organizationId, userId: actor.actorUserId, lock: true });
  if (!principal?.active || !['founder', 'l1', 'l2', 'l3'].includes(principal.level)) throw new DirectoryError('forbidden');
}
async function detail(tx: TenantTransaction, id: string): Promise<DirectoryDetail> {
  const school = (await tx.query<ManualDirectorySchool>({ text: 'SELECT * FROM schools_directory_schools WHERE id=$1', values: [id] })).rows[0];
  if (!school) throw new DirectoryError('notFound');
  const campuses = (await tx.query<DirectoryCampus>({ text: `SELECT * FROM (SELECT c.*, row_number() OVER (ORDER BY (SELECT min(h.id) FROM schools_directory_history h WHERE h.campus_id=c.id),c.id)::int AS display_number FROM schools_directory_campuses c WHERE school_id=$1) numbered WHERE deleted_at IS NULL ORDER BY display_number`, values: [id] })).rows.map(c => ({ ...c, record_version: Number(c.record_version) }));
  const modes = (await tx.query<{ field_key: string; shared: boolean }>({ text: 'SELECT field_key,shared FROM schools_directory_field_modes WHERE school_id=$1', values: [id] })).rows;
  const history = (await tx.query<DirectoryHistory>({ text: `SELECT h.id::text,h.campus_id,h.field_key,h.old_value,h.new_value,coalesce(p.display_name,u.id::text) AS actor,h.occurred_at,h.record_version FROM schools_directory_history h JOIN identity_users u ON u.id=h.actor_user_id LEFT JOIN access_organization_memberships m ON m.user_id=u.id AND m.organization_id=h.organization_id LEFT JOIN access_employee_profiles p ON p.membership_id=m.id AND p.organization_id=m.organization_id WHERE h.school_id=$1 ORDER BY h.id DESC`, values: [id] })).rows.map(h => ({ ...h, occurred_at: new Date(h.occurred_at).toISOString(), record_version: Number(h.record_version) }));
  return { school: { ...school, record_version: Number(school.record_version) }, campuses, modes: Object.fromEntries(modes.map(m => [m.field_key, m.shared])), history };
}
export class ManualDirectoryRepository {
  private readonly runner: TenantTransactionRunner;
  constructor(runner: TenantTransactionRunner) {
    this.runner = runner;
  }
  list(actor: Actor, query: DirectoryListQuery = { search: '', level: '', district: '', page: 1, pageSize: 20 }): Promise<DirectoryListResult> {
    return this.runner.run(actor, async tx => {
      await authorize(tx, actor);
      const where = `WHERE ($1='' OR position(lower($1) in lower(concat_ws(' ',s.fields->>'school_name_zh',s.fields->>'school_name_en')))>0)
        AND ($2='' OR ($2='__unknown__' AND coalesce(s.fields->>'school_level','')='') OR s.fields->>'school_level'=$2)
        AND ($3='' OR EXISTS(SELECT 1 FROM schools_directory_campuses c WHERE c.school_id=s.id AND c.deleted_at IS NULL AND (c.fields->>'district'=$3 OR ($3='__unknown__' AND coalesce(c.fields->>'district','')=''))))`;
      const values = [query.search, query.level, query.district];
      const total = Number((await tx.query<{ count: string }>({ text: `SELECT count(*) FROM schools_directory_schools s ${where}`, values })).rows[0]!.count);
      const rows = (await tx.query<ManualDirectorySchool>({ text: `SELECT s.*,ARRAY(SELECT DISTINCT c.fields->>'district' FROM schools_directory_campuses c WHERE c.school_id=s.id AND c.deleted_at IS NULL AND c.fields->>'district' IS NOT NULL ORDER BY 1) AS districts,ARRAY(SELECT DISTINCT c.fields->>'finance_type' FROM schools_directory_campuses c WHERE c.school_id=s.id AND c.deleted_at IS NULL AND c.fields->>'finance_type' IS NOT NULL ORDER BY 1) AS finance_types FROM schools_directory_schools s ${where} ORDER BY s.id LIMIT $4 OFFSET $5`, values: [...values, query.pageSize, (query.page - 1) * query.pageSize] })).rows;
      return { items: rows.map(s => ({ ...s, record_version: Number(s.record_version) })), total, page: query.page, pageSize: query.pageSize };
    });
  }
  read(actor: Actor, id: string) {
    return this.runner.run(actor, async tx => {
      await authorize(tx, actor);
      return detail(tx, id);
    });
  }
  async mutate(actor: Actor, command: DirectoryCommand, key: string): Promise<string> {
    const stamp = new Date().toISOString();
    const result = await runIdempotentTransaction({
      runner: this.runner, context: actor,
      claim: { id: randomUUID(), organizationId: actor.organizationId, actorKind: 'user', actorOpaqueId: actor.actorUserId, operation: 'schools.directory.maintain', key, requestHash: hashRequestPayload(command), createdAt: stamp },
      revalidate: tx => authorize(tx, actor), execute: async tx => {
        const q = adapt(tx);
        const store = new DirectoryStructureStore(q);
        await store.context({ organizationId: actor.organizationId, actorId: actor.actorUserId, source: { kind: 'manual', operation: command.action, ...(command.action === 'restore' ? { restoredHistoryId: command.historyId } : {}) }, occurredAt: stamp });
        let id: string;
        if (command.action === 'create') {
          id = randomUUID();
          await store.create({ id, organizationId: actor.organizationId, edbNumber: null, origin: 'manual', fields: { school_name_zh: command.nameZh || null, school_name_en: command.nameEn || null }, campusId: randomUUID(), campusOrigin: 'manual', campusFields: {}, sharedFields: DIRECTORY_CAMPUS_FIELDS });
        } else {
          id = command.schoolId;
          const locked = await q.query('SELECT id FROM schools_directory_schools WHERE id=$1 AND record_version=$2 FOR UPDATE', [id, command.version]);
          if (!locked.rowCount) throw new DirectoryError('conflict');
          const current = await detail(tx, id);
          const campus = 'campusId' in command ? current.campuses.find(c => c.id === command.campusId) : undefined;
          if ('campusId' in command && command.campusId && !campus) throw new DirectoryError('notFound');
          if (command.action === 'fields') {
            const schoolChanges = command.changes.filter(c => (DIRECTORY_SCHOOL_FIELDS as readonly string[]).includes(c.field));
            if (schoolChanges.length) {
              const patch = Object.fromEntries(schoolChanges.map(c => [c.field, c.value]));
              const merged = { ...current.school.fields, ...patch };
              if (![merged.school_name_zh, merged.school_name_en].some(v => typeof v === 'string' && v.trim())) throw new DirectoryError('invalid');
              await q.query('UPDATE schools_directory_schools SET fields=fields || $2::jsonb,record_version=record_version+1 WHERE id=$1', [id, JSON.stringify(patch)]);
            }
            for (const change of command.changes.filter(c => (DIRECTORY_CAMPUS_FIELDS as readonly string[]).includes(c.field))) {
              const latest = await detail(tx, id);
              if (change.campusId) {
                const target = latest.campuses.find(c => c.id === change.campusId);
                if (!target) throw new DirectoryError('notFound');
                if (latest.modes[change.field]) throw new DirectoryError('invalid');
                await store.setCampusField(target.id, change.field as DirectoryCampusField, change.value, target.record_version);
              } else {
                const first = latest.campuses[0]!.fields[change.field] ?? null;
                if (!latest.campuses.every(c => directoryValuesEqual(change.field, first, c.fields[change.field] ?? null))) throw new DirectoryError('invalid');
                await store.setSharedField(id, change.field as DirectoryCampusField, change.value, latest.school.record_version);
              }
            }
          } else if (command.action === 'field') {
            if (['school_name_zh', 'school_name_en'].includes(command.field)) {
              const names = { ...current.school.fields, [command.field]: command.value };
              if (![names.school_name_zh, names.school_name_en].some(v => typeof v === 'string' && v.trim())) throw new DirectoryError('invalid');
            }
            if ((DIRECTORY_SCHOOL_FIELDS as readonly string[]).includes(command.field)) await store.setSchoolField(id, command.field as DirectorySchoolField, command.value, command.version);
            else if (campus) {
              if (current.modes[command.field]) throw new DirectoryError('invalid');
              await store.setCampusField(campus.id, command.field as DirectoryCampusField, command.value, campus.record_version);
            } else {
              const first = current.campuses[0]!.fields[command.field] ?? null;
              if (!current.campuses.every(c => directoryValuesEqual(command.field, first, c.fields[command.field] ?? null))) throw new DirectoryError('invalid');
              await store.setSharedField(id, command.field as DirectoryCampusField, command.value, command.version);
            }
          } else if (command.action === 'split') await store.splitField(id, command.field as DirectoryCampusField, command.version);
          else if (command.action === 'addCampus') {
            const fields = Object.fromEntries(DIRECTORY_CAMPUS_FIELDS.filter(f => current.modes[f]).map(f => [f, current.campuses[0]!.fields[f] ?? null]));
            await store.addCampus({ id: randomUUID(), schoolId: id, organizationId: actor.organizationId, origin: 'manual', fields });
          } else if (command.action === 'deleteCampus') {
            if (campus!.origin === 'edb') throw new DirectoryError('edbCampus');
            if (current.campuses.length === 1) throw new DirectoryError('lastCampus');
            await store.deleteCampus(campus!.id, campus!.record_version);
          } else if (command.action === 'closed') await q.query('UPDATE schools_directory_schools SET is_closed=$2,record_version=record_version+1 WHERE id=$1', [id, command.value]);
          else if (command.action === 'restore') {
            const h = current.history.find(h => h.id === command.historyId);
            if (!h) throw new DirectoryError('notFound');
            const target = h.campus_id ? current.campuses.find(c => c.id === h.campus_id) : undefined;
            if (h.campus_id && !target) throw new DirectoryError('invalid');
            await store.restoreField(h.id, target?.record_version ?? command.version, command.version);
          }
          // Every successful school command advances the school aggregate token,
          // including single-campus changes. Parent lock spans the full transaction.
          await q.query('UPDATE schools_directory_schools SET record_version=record_version+1 WHERE id=$1', [id]);
        }
        return { state: 'completed', resultReference: id, responseHash: hashRequestPayload({ id }), updatedAt: stamp, value: id };
      }
    });
    return result.resultReference;
  }
}
