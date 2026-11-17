'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiClientError, listManualDirectory, readManualDirectory, maintainManualDirectory } from '@/modules/schools/client';
import {
  DIRECTORY_CAMPUS_FIELDS, DIRECTORY_OPTIONS, directoryValuesEqual, campusTitle,
  type DirectoryCommand, type DirectoryDetail, type DirectoryListResult, type DirectoryValue,
} from '@/modules/schools/public';
import { Page, PageHeader, Card, Button, Tag, DataList, MissingCount, FilledData, Input, Select, Search, Chips, Table, Pagination, Notice, Empty, Confirm } from '@/components/ui/standard';
const TECHNICAL_FIELDS = ['source_school_key', 'profile_url'];
const isFilled = (value: DirectoryValue | undefined) => value !== null && value !== undefined && value !== '';
type Change = { field: string; value: DirectoryValue; campusId?: string };
const GROUPS = [
  { key: 'identity', fields: ['school_name_zh', 'school_name_en'] },
  { key: 'features', fields: ['school_level', 'student_gender', 'is_sen'] },
  { key: 'tuition', fields: ['tuition_info', 'tuition_year', 'tuition_source_url'] },
  { key: 'boarding', fields: ['has_boarding', 'boarding_info'] },
];
export default function SchoolDirectoryPage() {
  const { t } = useTranslation();
  const text = (key: string) => t(`schoolDirectory.${key}`);
  const label = (field: string) => t(`schoolDirectory.fields.${field}`);
  const [result, setResult] = useState<DirectoryListResult>({ items: [], total: 0, page: 1, pageSize: 20 });
  const [detail, setDetail] = useState<DirectoryDetail | null>(null);
  const [search, setSearch] = useState('');
  const [level, setLevel] = useState('');
  const [district, setDistrict] = useState('');
  const [page, setPage] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const [creating, setCreating] = useState(false);
  const [nameZh, setNameZh] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, Change>>({});
  const [splitFields, setSplitFields] = useState<string[]>([]);
  const [splitField, setSplitField] = useState('');
  const [historyField, setHistoryField] = useState('');
  const [historyAll, setHistoryAll] = useState(false);
  const [confirm, setConfirm] = useState<{ title: string; description: string; command: DirectoryCommand } | null>(null);
  const pending = useRef<{ payload: string; key: string } | null>(null);
  const error = useCallback((e: unknown) => {
    setFailed(true);
    setMessage(e instanceof ApiClientError
      ? e.status === 409 ? 'conflict' : [401, 403].includes(e.status) ? 'denied'
        : [400, 422].includes(e.status) ? 'invalid' : 'error' : 'error');
  }, []);
  useEffect(() => {
    let active = true;
    listManualDirectory({ search, level, district, page, pageSize: 20 })
      .then(rows => {
        if (active) {
          setResult(rows);
          setLoading(false);
        }
      })
      .catch(e => {
        if (active) {
          error(e);
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [search, level, district, page, refresh, error]);
  function filter(update: () => void) {
    update();
    setPage(1);
    setLoading(true);
  }
  async function open(id: string, preserveDraft = false) {
    setBusy(true);
    try {
      setDetail(await readManualDirectory(id));
      if (!preserveDraft) {
        setEditing(null);
        setDraft({});
        setSplitFields([]);
      }
      setMessage('');
      setFailed(false);
    } catch (e) {
      error(e);
    } finally {
      setBusy(false);
    }
  }
  async function send(command: DirectoryCommand): Promise<boolean> {
    setBusy(true);
    setMessage('');
    const payload = JSON.stringify(command);
    if (pending.current?.payload !== payload) pending.current = { payload, key: crypto.randomUUID() };
    try {
      const id = await maintainManualDirectory(command, pending.current.key);
      setDetail(await readManualDirectory(id));
      setRefresh(v => v + 1);
      setFailed(false);
      setMessage('saved');
      pending.current = null;
      return true;
    } catch (e) {
      error(e);
      return false;
    } finally {
      setBusy(false);
    }
  }
  function begin(group: string) {
    setEditing(group);
    setDraft({});
    setMessage('');
  }
  function change(field: string, value: DirectoryValue, campusId?: string) {
    setDraft(values => ({ ...values, [`${campusId ?? ''}:${field}`]: { field, value, ...(campusId ? { campusId } : {}) } }));
  }
  const display = (value: DirectoryValue | undefined) => value === null || value === undefined || value === ''
    ? text('unknown') : typeof value === 'boolean' ? text(value ? 'yes' : 'no') : value;
  const readItems = (fields: readonly string[], values: Record<string, DirectoryValue>) => fields.map(field => ({
    label: label(field), value: display(values[field]), filled: isFilled(values[field]),
  }));
  const missingLabel = (count: number) => t('schoolDirectory.missingFields', { count });
  const commonCampusFields = DIRECTORY_CAMPUS_FIELDS.filter(field => !splitFields.includes(field)
    && detail?.campuses.every(campus => directoryValuesEqual(
      field, detail.campuses[0]?.fields[field] ?? null, campus.fields[field] ?? null,
    )));
  const differentCampusFields = DIRECTORY_CAMPUS_FIELDS.filter(field => !commonCampusFields.includes(field));
  const missingCampusFields = DIRECTORY_CAMPUS_FIELDS.filter(field => !TECHNICAL_FIELDS.includes(field)
    && detail?.campuses.some(campus => !isFilled(campus.fields[field]))).length;
  const school = detail?.school;
  const base = school ? { schoolId: school.id, version: school.record_version } : null;
  async function saveGroup() {
    if (!base) return;
    const changes = Object.values(draft).filter(c => {
      const previous = c.campusId ? detail!.campuses.find(item => item.id === c.campusId)?.fields[c.field]
        : DIRECTORY_CAMPUS_FIELDS.some(f => f === c.field) ? detail!.campuses[0]?.fields[c.field] : school!.fields[c.field];
      return (previous ?? null) !== c.value;
    });
    if (!changes.length || await send({ ...base, action: 'fields', changes })) {
      setEditing(null);
      setDraft({});
      setSplitFields([]);
    }
  }
  function editor(field: string, value: DirectoryValue, campusId?: string, suffix = '') {
    const key = `${campusId ?? ''}:${field}`;
    return <ValueInput
      key={key}
      field={field}
      label={`${label(field)}${suffix}`}
      value={draft[key]?.value ?? (key in draft ? null : value)}
      onChange={v => change(field, v, campusId)} />;
  }
  const editButtons = <div className="ui-actions">
    <Button disabled={busy} onClick={() => {
      setEditing(null);
      setDraft({});
      setSplitFields([]);
    }}>{t('ui.cancel')}</Button>
    <Button variant="primary" disabled={busy} onClick={() => void saveGroup()}>{text('save')}</Button>
  </div>;
  return <Page>
    {(busy || message) && <Notice warning={failed}>{busy ? text('loading') : text(message)}{failed && school && <Button onClick={() => void open(school.id, true)}>{text('reload')}</Button>}</Notice>}
    {school && detail && base ? <>
      <div>
        <Button disabled={busy || !!editing} onClick={() => {
          setDetail(null);
          setMessage('');
        }}>{text('back')}</Button>
      </div>
      <PageHeader
        title={String(school.fields.school_name_zh || school.fields.school_name_en)}
        description={String(school.fields.school_name_en || '')}>
        <div className="ui-actions">
          <Tag tone={school.origin === 'manual' ? 'primary' : 'neutral'}>{text(school.origin)}</Tag>
          <Tag>{t('schoolDirectory.campusCount', { count: detail.campuses.length })}</Tag>
          {school.is_closed && <Tag tone="warning">{text('closed')}</Tag>}
        </div>
      </PageHeader>
      <div className="ui-grid">
        {GROUPS.map(group => <Card key={group.key} title={text(group.key)} editing={editing === group.key}
          action={editing !== group.key && <Button variant="text" disabled={busy || !!editing} onClick={() => begin(group.key)}>{text('edit')}</Button>}>
          {editing === group.key ? <><div className="ui-grid">{group.fields.map(field => editor(field, school.fields[field] ?? null))}</div>{editButtons}</>
            : <FilledData items={[
              ...readItems(group.fields, school.fields),
              ...(group.key === 'identity' ? [{ label: text('edbNumber'), value: display(school.edb_number), filled: isFilled(school.edb_number) }] : []),
            ]} missingLabel={missingLabel} />}
        </Card>)}
      </div>
      <Card title={text('campuses')} editing={editing === 'campuses'}
        action={editing !== 'campuses' && <Button variant="text" disabled={busy || !!editing} onClick={() => begin('campuses')}>{text('edit')}</Button>}>
        <div className="ui-actions">
          <Button variant="secondary" disabled={busy || !!editing} onClick={() => void send({ ...base, action: 'addCampus' })}>{text('addCampus')}</Button>
        </div>
        <div className="ui-grid">
          {commonCampusFields.filter(field => editing === 'campuses'
            || (!TECHNICAL_FIELDS.includes(field) && isFilled(detail.campuses[0]?.fields[field]))).map(field => editing === 'campuses'
            ? editor(field, detail.campuses[0]?.fields[field] ?? null)
            : <DataList key={field} items={[{ label: label(field), value: display(detail.campuses[0]?.fields[field]) }]} />)}
        </div>
        <div className="ui-grid">
          {detail.campuses.map(campus => {
            const title = campusTitle(campus, text('campusFallback'));
            const different = differentCampusFields;
            const visible = different.filter(field => !TECHNICAL_FIELDS.includes(field) && isFilled(campus.fields[field]));
            if (editing !== 'campuses' && !visible.length) return null;
            return <div className="ui-inset ui-stack" key={campus.id}>
              <h3>
                <strong>{title}</strong>
              </h3>
              {editing === 'campuses' ? different.map(field => editor(field, campus.fields[field] ?? null, campus.id, ` · ${title}`))
                : <DataList items={visible.map(field => ({ label: label(field), value: display(campus.fields[field]) }))} />}
              {editing === 'campuses' && <div>
                <Button
                  disabled={busy || campus.origin === 'edb' || detail.campuses.length === 1}
                  onClick={() => setConfirm({ title: text('deleteCampus'), description: title, command: { ...base, action: 'deleteCampus', campusId: campus.id } })}>
                  {text('deleteCampus')}
                </Button>
                {(campus.origin === 'edb' || detail.campuses.length === 1) && <p className="ui-muted">{text(campus.origin === 'edb' ? 'edbCampus' : 'lastCampus')}</p>}
              </div>}
            </div>;
          })}
        </div>
        {editing !== 'campuses' && <MissingCount count={missingCampusFields} label={missingLabel} />}
        {editing === 'campuses' ? editButtons : <details>
          <summary className="ui-link">{text('split')}</summary>
          <div className="ui-actions">
            <Select label={text('chooseField')} value={splitField} onChange={e => setSplitField(e.target.value)}>
              <option value="">{text('chooseField')}</option>
              {DIRECTORY_CAMPUS_FIELDS.map(field => <option key={field} value={field}>{label(field)}</option>)}
            </Select>
            <Button
              disabled={!splitField || busy || !!editing}
              onClick={async () => {
                if (!detail.modes[splitField] || await send({ ...base, action: 'split', field: splitField })) {
                  setSplitFields(fields => [...fields, splitField]);
                  begin('campuses');
                }
              }}>
              {text('split')}
            </Button>
          </div>
        </details>}
      </Card>
      <div>
        <Button disabled={busy || !!editing} onClick={() => void send({ ...base, action: 'closed', value: !school.is_closed })}>{text(school.is_closed ? 'unmarkClosed' : 'markClosed')}</Button>
      </div>
      <details className="ui-history">
        <summary>{text('history')}</summary>
        <Select label={text('chooseField')} value={historyField} onChange={e => {
          setHistoryField(e.target.value);
          setHistoryAll(false);
        }}>
          <option value="">{text('allFields')}</option>
          {[...GROUPS.flatMap(g => g.fields), ...DIRECTORY_CAMPUS_FIELDS, 'is_closed'].map(f => <option key={f} value={f}>{label(f)}</option>)}
        </Select>
        {detail.history.filter(h => (!historyField || h.field_key === historyField) && [...GROUPS.flatMap(g => g.fields), ...DIRECTORY_CAMPUS_FIELDS, 'is_closed'].includes(h.field_key)).slice(0, historyAll ? undefined : 5).map(h => {
          const campus = detail.campuses.find(c => c.id === h.campus_id);
          return <article key={h.id}>
            <strong>{label(h.field_key)} {h.campus_id ? campus ? campusTitle(campus, text('campusFallback')) : text('deletedCampus') : ''}</strong>
            <p>{display(h.old_value)} → {display(h.new_value)}</p>
            <p>{h.actor} · {new Date(h.occurred_at).toLocaleString()} · {text('version')} {h.record_version}</p>
            <Button
              disabled={busy || !!editing || (!!h.campus_id && !campus)}
              onClick={() => setConfirm({ title: text('restore'), description: `${label(h.field_key)}: ${display(h.old_value)}`, command: { ...base, action: 'restore', historyId: h.id } })}>
              {text('restore')}
            </Button>
          </article>;
        })}
        {!historyAll && <Button onClick={() => setHistoryAll(true)}>{text('viewAll')}</Button>}
      </details>
      <details className="ui-history">
        <summary>{text('systemData')}</summary>
        <DataList items={[{ label: text('id'), value: school.id }]} />
        {detail.campuses.map(campus => <div key={campus.id}>
          <strong>{campusTitle(campus, text('campusFallback'))}</strong>
          <FilledData items={readItems(TECHNICAL_FIELDS, campus.fields)} missingLabel={missingLabel} />
        </div>)}
      </details>
    </> : <>
      <PageHeader
        title={text('title')}
        description={text('listDescription')}
        action={<Button variant="primary" onClick={() => setCreating(true)}>{text('create')}</Button>} />
      <Search label={text('search')} placeholder={text('searchPlaceholder')} value={search} onChange={e => filter(() => setSearch(e.target.value))} />
      <div className="ui-filters">
        <Chips
          label={label('school_level')}
          value={level}
          onChange={v => filter(() => setLevel(v))}
          items={[{ value: '', label: text('all') }, ...DIRECTORY_OPTIONS.school_level.map(v => ({ value: v, label: v })), { value: '__unknown__', label: text('unknown') }]} />
        <Select label={label('district')} value={district} onChange={e => filter(() => setDistrict(e.target.value))}>
          <option value="">{text('allDistricts')}</option>
          {DIRECTORY_OPTIONS.district.map(value => <option key={value}>{value}</option>)}
          <option value="__unknown__">{text('unknown')}</option>
        </Select>
      </div>
      <Card>
        {loading ? <Notice>{text('loading')}</Notice> : result.items.length ? <Table headings={[text('school'), label('school_level'), label('finance_type'), label('district'), text('origin')]}>
          {result.items.map(item => <tr key={item.id}>
            <td>
              <button className="ui-link" onClick={() => void open(item.id)}>{String(item.fields.school_name_zh || item.fields.school_name_en)}</button>
              <div className="ui-muted">{String(item.fields.school_name_en || '')}</div>
              {item.is_closed && <Tag tone="warning">{text('closed')}</Tag>}
            </td>
            <td>{display(item.fields.school_level)}</td>
            <td>{item.finance_types?.join('、') || text('unknown')}</td>
            <td>{item.districts?.join('、') || text('unknown')}</td>
            <td>
              <Tag tone={item.origin === 'manual' ? 'primary' : 'neutral'}>{text(item.origin)}</Tag>
            </td>
          </tr>)}
        </Table> : <Empty title={search || level || district ? text('noMatches') : text('empty')} detail={text('listDescription')} />}
        <Pagination page={result.page} pageSize={result.pageSize} total={result.total} onChange={p => {
          setPage(p);
          setLoading(true);
        }} />
      </Card>
    </>}
    {creating && <Confirm
      title={text('create')}
      onCancel={() => setCreating(false)}
      confirmLabel={text('create')}
      onConfirm={async () => {
        if (!(nameZh.trim() || nameEn.trim())) {
          setFailed(true);
          setMessage('invalid');
          return;
        }
        if (await send({ action: 'create', nameZh, nameEn })) {
          setCreating(false);
          setNameZh('');
          setNameEn('');
        }
      }}>
      <p>{text('minimum')}</p>
      <Input label={text('nameZh')} value={nameZh} onChange={e => setNameZh(e.target.value)} />
      <Input label={text('nameEn')} value={nameEn} onChange={e => setNameEn(e.target.value)} />
      {failed && <Notice warning>{text(message)}</Notice>}
    </Confirm>}
    {confirm && <Confirm
      title={confirm.title}
      onCancel={() => setConfirm(null)}
      onConfirm={async () => {
        const command = confirm.command;
        setConfirm(null);
        if (await send(command) && command.action === 'deleteCampus') {
          setDraft(values => Object.fromEntries(Object.entries(values).filter(([, change]) => change.campusId !== command.campusId)));
        }
      }}>
      <p>{confirm.description}</p>
    </Confirm>}
  </Page>;
}
function ValueInput({ field, label, value, onChange }: { field: string; label: string; value: DirectoryValue; onChange: (value: DirectoryValue) => void }) {
  const { t } = useTranslation();
  const boolean = ['is_sen', 'has_boarding'].includes(field);
  const options = DIRECTORY_OPTIONS[field];
  if (boolean || options) {
    const values = boolean ? ['true', 'false'] : [...options];
    if (value !== null && !values.includes(String(value))) values.push(String(value));
    return <Select
      label={label}
      value={value === null ? '' : String(value)}
      onChange={e => onChange(e.target.value === '' ? null : boolean ? e.target.value === 'true' : e.target.value)}>
      <option value="">{t('schoolDirectory.unknown')}</option>
      {values.map(v => <option value={v} key={v}>{boolean ? t(`schoolDirectory.${v === 'true' ? 'yes' : 'no'}`) : v}</option>)}
    </Select>;
  }
  return <Input label={label} placeholder={t('schoolDirectory.unknown')} value={value === null ? '' : String(value)} onChange={e => onChange(e.target.value || null)} />;
}
