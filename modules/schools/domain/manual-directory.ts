import { DIRECTORY_CAMPUS_FIELDS, DIRECTORY_SCHOOL_FIELDS, type DirectoryValue } from './directory-structure.ts';
export { DIRECTORY_CAMPUS_FIELDS, DIRECTORY_SCHOOL_FIELDS } from './directory-structure.ts';
export type { DirectoryValue } from './directory-structure.ts';
export type DirectoryCommand =
  | { action: 'fields'; schoolId: string; version: number; changes: { field: string; value: DirectoryValue; campusId?: string }[] }
  | { action: 'create'; nameZh: string; nameEn: string }
  | { action: 'field'; schoolId: string; version: number; field: string; value: DirectoryValue; campusId?: string }
  | { action: 'split'; schoolId: string; version: number; field: string }
  | { action: 'addCampus'; schoolId: string; version: number }
  | { action: 'deleteCampus'; schoolId: string; version: number; campusId: string }
  | { action: 'closed'; schoolId: string; version: number; value: boolean }
  | { action: 'restore'; schoolId: string; version: number; historyId: string };
export interface DirectoryCampus {
  id: string;
  display_number: number;
  origin: 'manual' | 'edb';
  fields: Record<string, DirectoryValue>;
  record_version: number;
}
export interface ManualDirectorySchool {
  districts?: string[];
  finance_types?: string[];
  id: string;
  edb_number: string | null;
  origin: 'manual' | 'edb';
  fields: Record<string, DirectoryValue>;
  is_closed: boolean | null;
  record_version: number;
}
export interface DirectoryHistory {
  id: string;
  campus_id: string | null;
  field_key: string;
  old_value: DirectoryValue;
  new_value: DirectoryValue;
  actor: string;
  occurred_at: string;
  record_version: number;
}
export interface DirectoryDetail {
  school: ManualDirectorySchool;
  campuses: DirectoryCampus[];
  modes: Record<string, boolean>;
  history: DirectoryHistory[];
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export class DirectoryError extends Error { }
export function parseDirectoryCommand(input: unknown): DirectoryCommand {
  const invalid = () => {
    throw new DirectoryError('invalid');
  };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid();
  const x = input as Record<string, unknown>;
  const str = (v: unknown): v is string => typeof v === 'string';
  if (x.action === 'create') {
    if (!str(x.nameZh) || !str(x.nameEn) || !(x.nameZh.trim() || x.nameEn.trim())) return invalid();
    return { action: 'create', nameZh: x.nameZh, nameEn: x.nameEn };
  }
  if (!str(x.schoolId) || !uuid.test(x.schoolId) || !Number.isSafeInteger(x.version) || Number(x.version) < 1) return invalid();
  const base = { schoolId: x.schoolId, version: Number(x.version) };
  if (x.action === 'fields') {
    if (!Array.isArray(x.changes) || x.changes.length === 0) return invalid();
    const seen = new Set<string>();
    const changes = x.changes.map(change => {
      if (!change || typeof change !== 'object' || Array.isArray(change)) return invalid();
      const parsed = parseDirectoryCommand({ ...change, ...base, action: 'field' });
      if (parsed.action !== 'field') return invalid();
      const key = `${parsed.campusId ?? ''}:${parsed.field}`;
      if (seen.has(key)) return invalid();
      seen.add(key);
      return { field: parsed.field, value: parsed.value, ...(parsed.campusId ? { campusId: parsed.campusId } : {}) };
    });
    return { ...base, action: 'fields', changes };
  }
  if (x.action === 'addCampus') return { ...base, action: x.action };
  if (x.action === 'closed' && typeof x.value === 'boolean') return { ...base, action: x.action, value: x.value };
  if (x.action === 'restore' && str(x.historyId) && /^[1-9][0-9]*$/.test(x.historyId)) return { ...base, action: x.action, historyId: x.historyId };
  if (x.action === 'deleteCampus' && str(x.campusId) && uuid.test(x.campusId)) return { ...base, action: x.action, campusId: x.campusId };
  if (!str(x.field)) return invalid();
  const campus = (DIRECTORY_CAMPUS_FIELDS as readonly string[]).includes(x.field);
  if (x.action === 'split' && campus) return { ...base, action: x.action, field: x.field };
  if (x.action !== 'field' || (!campus && !(DIRECTORY_SCHOOL_FIELDS as readonly string[]).includes(x.field))) return invalid();
  const boolean = ['is_sen', 'has_boarding'].includes(x.field);
  if (x.value !== null && typeof x.value !== (boolean ? 'boolean' : 'string')) return invalid();
  if (x.campusId !== undefined && (!campus || !str(x.campusId) || !uuid.test(x.campusId))) return invalid();
  return { ...base, action: 'field', field: x.field, value: x.value as DirectoryValue, ...(x.campusId ? { campusId: x.campusId as string } : {}) };
}
/** Display comparison only. No source values are rewritten. */
export function directoryValuesEqual(field: string, a: DirectoryValue, b: DirectoryValue): boolean {
  const normalize = (v: DirectoryValue) => field === 'official_website' && typeof v === 'string'
    ? v.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '') : v;
  return normalize(a) === normalize(b);
}
export interface DirectoryListQuery {
  search: string;
  level: string;
  district: string;
  page: number;
  pageSize: number;
}
export interface DirectoryListResult {
  items: ManualDirectorySchool[];
  total: number;
  page: number;
  pageSize: number;
}
export function parseDirectoryListQuery(params: URLSearchParams): DirectoryListQuery {
  const page = Number(params.get('page') ?? 1);
  const pageSize = Number(params.get('pageSize') ?? 20);
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new DirectoryError('invalid');
  return { search: params.get('search') ?? '', level: params.get('level') ?? '', district: params.get('district') ?? '', page, pageSize };
}
export function campusTitle(campus: DirectoryCampus, fallback: string): string {
  const parts = ['location_marker', 'address', 'school_session'].map(k => campus.fields[k]).filter(v => typeof v === 'string' && v.trim());
  return parts.length ? parts.join(' · ') : `${fallback} ${campus.display_number}`;
}
