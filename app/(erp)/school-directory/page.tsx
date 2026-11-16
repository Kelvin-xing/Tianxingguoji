'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiClientError, listManualDirectory, readManualDirectory, maintainManualDirectory } from '@/modules/schools/client';
import { DIRECTORY_SCHOOL_FIELDS, DIRECTORY_CAMPUS_FIELDS, directoryValuesEqual, type DirectoryCommand, type DirectoryDetail, type ManualDirectorySchool, type DirectoryValue } from '@/modules/schools/public';
const control = 'rounded border border-slate-300 bg-white px-3 py-2 text-slate-900 disabled:opacity-50';
export default function SchoolDirectoryPage() {
  const { t } = useTranslation();
  const text = (key: string) => t(`schoolDirectory.${key}`);
  const [items,setItems] = useState<ManualDirectorySchool[]>([]);
  const [detail,setDetail] = useState<DirectoryDetail | null>(null);
  const [search,setSearch] = useState(''); const [nameZh,setNameZh] = useState(''); const [nameEn,setNameEn] = useState('');
  const [busy,setBusy] = useState(false); const [message,setMessage] = useState(''); const [failed,setFailed] = useState(false);
  const [split,setSplit] = useState<string[]>([]);
  const error = useCallback((e: unknown) => { setFailed(true); setMessage(e instanceof ApiClientError ? e.status === 409 ? 'conflict' : [401,403].includes(e.status) ? 'denied' : [400,422].includes(e.status) ? 'invalid' : 'error' : 'error'); },[]);
  const load = useCallback(async () => { try { setItems(await listManualDirectory()); } catch(e) { error(e); } },[error]);
  useEffect(() => { let active = true; listManualDirectory().then(rows => { if (active) setItems(rows); }).catch(e => { if (active) error(e); }); return () => { active = false; }; },[error]);
  const pending = useRef<{ payload: string; key: string } | null>(null);
  async function open(id: string) { setBusy(true); try { setDetail(await readManualDirectory(id)); setSplit([]); setMessage(''); setFailed(false); } catch(e) { error(e); } finally { setBusy(false); } }
  async function send(command: DirectoryCommand) {
    setBusy(true); setMessage('');
    const payload = JSON.stringify(command);
    if (pending.current?.payload !== payload) pending.current = { payload, key: crypto.randomUUID() };
    try { const id = await maintainManualDirectory(command,pending.current.key); setDetail(await readManualDirectory(id)); await load(); setFailed(false); setMessage('saved'); pending.current = null; }
    catch(e) { error(e); } finally { setBusy(false); }
  }
  const display = (v: DirectoryValue) => v === null ? text('unknown') : typeof v === 'boolean' ? text(v ? 'yes' : 'no') : v;
  const fieldLabel = (f: string) => t(`schoolDirectory.fields.${f}`);
  const school = detail?.school;
  const base = school ? { schoolId: school.id, version: school.record_version } : null;
  return <div className="mx-auto max-w-6xl space-y-6 p-4 text-slate-900">
    <h1 className="text-2xl font-semibold">{text('title')}</h1>
    <div role={failed ? 'alert' : 'status'} aria-live="polite">{busy ? text('loading') : message ? text(message) : ''}</div>
    {school && detail && base ? <>
      <div className="flex flex-wrap gap-3"><button className={control} onClick={() => { setDetail(null); setMessage(''); }}>{text('back')}</button><button className={control} disabled={busy} onClick={() => void open(school.id)}>{text('reload')}</button></div>
      <h2 className="text-xl font-semibold">{String(school.fields.school_name_zh || school.fields.school_name_en)}</h2>
      <dl className="grid gap-2"><dt>{text('id')}</dt><dd>{school.id}</dd><dt>{text('edbNumber')}</dt><dd>{school.edb_number ?? text('unknown')}</dd><dt>{text('origin')}</dt><dd>{text(school.origin)}</dd></dl>
      <div>{school.is_closed === true && <strong>{text('closed')} </strong>}<button className={control} disabled={busy} onClick={() => void send({ ...base,action: 'closed',value: !school.is_closed })}>{text(school.is_closed ? 'unmarkClosed' : 'markClosed')}</button></div>
      <div className="grid gap-4 md:grid-cols-2">{DIRECTORY_SCHOOL_FIELDS.map(field => <Field key={`${field}:${school.record_version}`} label={fieldLabel(field)} value={school.fields[field] ?? null} boolean={['is_sen','has_boarding'].includes(field)} disabled={busy} onSave={value => send({ ...base,action: 'field',field,value })} />)}</div>
      <div className="flex flex-wrap gap-3"><button className={control} disabled={busy} onClick={() => void send({ ...base,action: 'addCampus' })}>{text('addCampus')}</button>{detail.campuses.map((c,i) => <div key={c.id} className="rounded border p-3"><strong>{t('schoolDirectory.campus',{number:i+1})}</strong><p>{text(c.origin)}</p><button className={control} disabled={busy || c.origin === 'edb' || detail.campuses.length === 1} onClick={() => void send({ ...base,action:'deleteCampus',campusId:c.id })}>{text('deleteCampus')}</button>{(c.origin === 'edb' || detail.campuses.length === 1) && <p>{text(c.origin === 'edb' ? 'edbCampus' : 'lastCampus')}</p>}</div>)}</div>
      {DIRECTORY_CAMPUS_FIELDS.map(field => {
        const value = detail.campuses[0]?.fields[field] ?? null;
        const equal = detail.campuses.every(c => directoryValuesEqual(field,value,c.fields[field] ?? null));
        const separated = split.includes(field) || !equal;
        return <section key={field} className="space-y-3 rounded border p-4"><h3 className="font-semibold">{fieldLabel(field)}</h3>
          {!separated ? <><Field key={`${field}:${school.record_version}`} label={`${fieldLabel(field)} · ${text('shared')}`} value={value} disabled={busy} onSave={v => send({ ...base,action:'field',field,value:v })} /><button className={control} disabled={busy} onClick={async () => { if (detail.modes[field]) await send({ ...base,action:'split',field }); setSplit(s => [...s,field]); }}>{text('split')}</button></>
            : <div className="grid gap-4 md:grid-cols-2">{detail.campuses.map((c,i) => <Field key={`${c.id}:${field}:${school.record_version}`} label={`${fieldLabel(field)} · ${t('schoolDirectory.campus',{number:i+1})}`} value={c.fields[field] ?? null} disabled={busy} onSave={v => send({ ...base,action:'field',field,value:v,campusId:c.id })} />)}</div>}
        </section>;
      })}
      <section><h2 className="text-xl font-semibold">{text('history')}</h2><div className="space-y-3">{detail.history.filter(h => [...DIRECTORY_SCHOOL_FIELDS,...DIRECTORY_CAMPUS_FIELDS,'is_closed'].includes(h.field_key)).map(h => {
        const index = detail.campuses.findIndex(c => c.id === h.campus_id);
        return <article key={h.id} className="rounded border p-3"><h3 className="font-semibold">{fieldLabel(h.field_key)} {h.campus_id ? index < 0 ? text('deletedCampus') : t('schoolDirectory.campus',{number:index+1}) : ''}</h3><p>{text('actor')}: {h.actor} · {text('time')}: {new Date(h.occurred_at).toLocaleString()} · {text('version')}: {h.record_version}</p><p>{text('before')}: {display(h.old_value)} → {text('after')}: {display(h.new_value)}</p><button className={control} disabled={busy || (!!h.campus_id && index < 0)} onClick={() => void send({ ...base,action:'restore',historyId:h.id })}>{text('restore')}</button></article>;
      })}</div></section>
    </> : <>
      <form className="space-y-3 rounded border p-4" onSubmit={e => { e.preventDefault(); void send({ action:'create',nameZh,nameEn }); }}><h2 className="text-xl">{text('create')}</h2><p>{text('minimum')}</p><label className="block">{text('nameZh')}<input className={`${control} ml-3`} value={nameZh} onChange={e => setNameZh(e.target.value)} /></label><label className="block">{text('nameEn')}<input className={`${control} ml-3`} value={nameEn} onChange={e => setNameEn(e.target.value)} /></label><button className={control} disabled={busy || !(nameZh.trim() || nameEn.trim())}>{text('create')}</button></form>
      <label className="block">{text('search')}<input className={`${control} ml-3`} value={search} onChange={e => setSearch(e.target.value)} /></label>
      <ul className="space-y-2">{items.filter(s => `${s.fields.school_name_zh ?? ''} ${s.fields.school_name_en ?? ''}`.toLowerCase().includes(search.toLowerCase())).map(s => <li key={s.id}><button className={`${control} text-left`} disabled={busy} onClick={() => void open(s.id)}>{String(s.fields.school_name_zh || s.fields.school_name_en)} {s.is_closed === true ? text('closed') : ''}</button></li>)}</ul>{!items.length && <p>{text('empty')}</p>}
    </>}
  </div>;
}
function Field({ label,value,boolean = false,disabled,onSave }: { label: string; value: DirectoryValue; boolean?: boolean; disabled: boolean; onSave: (value: DirectoryValue) => Promise<void> }) {
  const { t } = useTranslation(); const [draft,setDraft] = useState(value === null ? '' : String(value));
  return <form className="space-y-2" onSubmit={e => { e.preventDefault(); void onSave(draft === '' ? null : boolean ? draft === 'true' : draft); }}><label className="block">{label}{boolean ? <select className={`${control} block w-full`} value={draft} onChange={e => setDraft(e.target.value)}><option value="">{t('schoolDirectory.unknown')}</option><option value="true">{t('schoolDirectory.yes')}</option><option value="false">{t('schoolDirectory.no')}</option></select> : <input className={`${control} block w-full`} placeholder={t('schoolDirectory.unknown')} value={draft} onChange={e => setDraft(e.target.value)} />}</label><button className={control} disabled={disabled}>{t('schoolDirectory.save')}</button></form>;
}
