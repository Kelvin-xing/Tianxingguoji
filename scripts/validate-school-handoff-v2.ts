/** Pure offline contract validation; no Schools runtime or database dependencies. */
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type ObjectValue = { [key: string]: Json };
type Rule = {
  $ref?: string; const?: Json; type?: string | string[]; enum?: Json[];
  required?: string[]; additionalProperties?: boolean; properties?: Record<string, Rule>;
  items?: Rule; minItems?: number; uniqueItems?: boolean; minLength?: number;
  pattern?: string; format?: string; minimum?: number; maximum?: number;
  $defs: Record<string, Rule>;
};
export type Issue = { path: string; code: string };
export type Result = { valid: boolean; errors: Issue[] };
const schema = JSON.parse(readFileSync(new URL('../contracts/school-crawl-handoff/v2/contract.schema.json', import.meta.url), 'utf8')) as Rule;
const object = (v: Json): v is ObjectValue => v !== null && typeof v === 'object' && !Array.isArray(v);
const compare = (a: string, b: string): number => {
  const left = Array.from(a, c => c.codePointAt(0)!), right = Array.from(b, c => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(left.length, right.length); i++) if (left[i] !== right[i]) return left[i] - right[i];
  return left.length - right.length;
};
const canonical = (v: Json): string => object(v)
  ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
  : Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : JSON.stringify(v);
function validFormat(value: string, name: string): boolean {
  if (name === 'academic-year') return Number(value.slice(5)) === (Number(value.slice(0, 4)) + 1) % 100;
  const date = name === 'calendar-date' ? `${value}T00:00:00Z` : value;
  const parsed = new Date(date);
  return Number(value.slice(0, 4)) >= 1 && !Number.isNaN(parsed.valueOf()) && parsed.toISOString().replace('.000Z', 'Z') === date;
}
type Field = { state: string; value: Json; reason: string | null; checked_at: string; evidence: Json[] };
type Evidence = { source_url: string; raw_record_id: string; collected_at: string };
type Document = {
  run: { crawl_id: string; started_at: string; checked_at: string; change_status: string; failure: Json; comparison: null | { previous_crawl_id: string } };
  school: { internal_school_id: string | null; edb_school_number: string | null; identity_evidence: Json[]; campus_variants: { edb_scrn: string; campus_identifier: Field }[] };
  admissions: { candidate_id: string; identity_mode: string; fields: Record<string, Field> }[];
  raw_records: { id: string; source_url: string; collected_at: string }[];
};

export function validate(doc: Json): Result {
  const errors: Issue[] = [];
  const add = (path: string, code: string): void => { errors.push({ path, code }); };
  const result = (): Result => ({ valid: errors.length === 0, errors: errors.sort((a, b) => compare(a.path, b.path) || compare(a.code, b.code)) });
  function structure(value: Json, rule: Rule, path: string): void {
    if (rule.$ref) rule = schema.$defs[rule.$ref.split('/').at(-1)!];
    if ('const' in rule && value !== rule.const) { add(path, 'SCHEMA_CONST'); return; }
    const kind = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    const kinds = typeof rule.type === 'string' ? [rule.type] : rule.type ?? [kind];
    if (!kinds.includes(kind)) { add(path, 'SCHEMA_TYPE'); return; }
    if (value === null) return;
    if (rule.enum && !rule.enum.includes(value)) { add(path, 'SCHEMA_ENUM'); return; }
    if (object(value)) {
      for (const k of rule.required ?? []) if (!Object.hasOwn(value, k)) add(`${path}.${k}`, 'SCHEMA_REQUIRED');
      for (const [k, item] of Object.entries(value)) {
        if (!Object.hasOwn(rule.properties ?? {}, k)) { if (rule.additionalProperties === false) add(`${path}.${k}`, 'SCHEMA_EXTRA'); }
        else structure(item, rule.properties![k], `${path}.${k}`);
      }
    } else if (Array.isArray(value)) {
      if (value.length < (rule.minItems ?? 0)) add(path, 'SCHEMA_MIN_ITEMS');
      if (rule.uniqueItems && new Set(value.map(canonical)).size !== value.length) add(path, 'SCHEMA_UNIQUE_ITEMS');
      value.forEach((item, i) => structure(item, rule.items!, `${path}[${i}]`));
    } else if (typeof value === 'string') {
      if ([...value].length < (rule.minLength ?? 0)) add(path, 'SCHEMA_MIN_LENGTH');
      else if (rule.pattern && !new RegExp(rule.pattern).test(value)) add(path, 'SCHEMA_PATTERN');
      else if (rule.format && !validFormat(value, rule.format)) add(path, 'SCHEMA_FORMAT');
    } else if (typeof value === 'number' && (value < (rule.minimum ?? value) || value > (rule.maximum ?? value))) add(path, 'SCHEMA_RANGE');
  }
  structure(doc, schema, '$');
  if (errors.length) return result();
  // Structural gate validates every property before the semantic typed view is used.
  const data = doc as unknown as Document;
  const { run, school } = data;
  const raw = new Map<string, Document['raw_records'][number]>();
  data.raw_records.forEach((record, i) => {
    if (raw.has(record.id)) add(`$.raw_records[${i}].id`, 'RAW_ID_DUPLICATE');
    raw.set(record.id, record);
  });
  if (run.started_at > run.checked_at) add('$.run.checked_at', 'RUN_TIME_ORDER');
  if (school.internal_school_id === null && school.edb_school_number === null) add('$.school', 'SCHOOL_IDENTITY_REQUIRED');
  if (run.change_status !== 'failed' && !school.identity_evidence.length) add('$.school.identity_evidence', 'IDENTITY_EVIDENCE_REQUIRED');
  const scrns = new Set<string>();
  school.campus_variants.forEach((campus, i) => {
    const p = `$.school.campus_variants[${i}]`;
    if (campus.edb_scrn.slice(0, 6) !== school.edb_school_number) add(`${p}.edb_scrn`, 'EDB_SCHOOL_MISMATCH');
    if (scrns.has(campus.edb_scrn)) add(`${p}.edb_scrn`, 'EDB_SCRN_DUPLICATE');
    scrns.add(campus.edb_scrn);
    if (campus.campus_identifier.state === 'known' && campus.campus_identifier.value !== campus.edb_scrn.slice(6, 10)) add(`${p}.campus_identifier.value`, 'CAMPUS_ID_MISMATCH');
  });
  const fields: Field[] = [];
  function walk(value: Json, path: string): void {
    if (object(value)) {
      if ('state' in value) {
        const field = value as unknown as Field;
        fields.push(field);
        if (field.state === 'known') {
          if (field.value === null) add(`${path}.value`, 'KNOWN_VALUE_REQUIRED');
          if (!field.evidence.length) add(`${path}.evidence`, 'KNOWN_EVIDENCE_REQUIRED');
          if (field.reason !== null) add(`${path}.reason`, 'KNOWN_REASON_MUST_BE_NULL');
        } else {
          if (field.value !== null) add(`${path}.value`, 'NON_KNOWN_VALUE_MUST_BE_NULL');
          if (field.reason === null) add(`${path}.reason`, 'REASON_REQUIRED');
        }
        if (field.checked_at !== run.checked_at) add(`${path}.checked_at`, 'FIELD_CHECK_TIME_MISMATCH');
      }
      if ('raw_record_id' in value) {
        const ev = value as unknown as Evidence;
        const record = raw.get(ev.raw_record_id);
        if (!record) add(`${path}.raw_record_id`, 'RAW_REFERENCE_MISSING');
        else if (record.source_url !== ev.source_url || record.collected_at !== ev.collected_at) add(`${path}.raw_record_id`, 'RAW_PROVENANCE_MISMATCH');
      }
      if (typeof value.collected_at === 'string' && value.collected_at > run.checked_at) add(`${path}.collected_at`, 'COLLECTION_AFTER_CHECK');
      for (const [k, item] of Object.entries(value)) walk(item, `${path}.${k}`);
    } else if (Array.isArray(value)) value.forEach((item, i) => walk(item, `${path}[${i}]`));
  }
  walk(doc, '$');
  const ids = new Set<string>(), keys = new Set<string>();
  data.admissions.forEach((record, i) => {
    const p = `$.admissions[${i}]`;
    if (ids.has(record.candidate_id)) add(`${p}.candidate_id`, 'CANDIDATE_ID_DUPLICATE');
    ids.add(record.candidate_id);
    const fs = record.fields;
    const known = ['academic_year', 'admission_type', 'grade'].every(k => fs[k].state === 'known' && fs[k].value !== null);
    if (!known) {
      if (record.identity_mode !== 'new-candidate') add(`${p}.identity_mode`, 'NEW_CANDIDATE_REQUIRED');
      if (run.change_status === 'unchanged') add(`${p}.identity_mode`, 'UNCHANGED_HAS_NEW_CANDIDATE');
    } else {
      if (record.identity_mode !== 'exact') add(`${p}.identity_mode`, 'EXACT_MODE_REQUIRED');
      const key = JSON.stringify([fs.academic_year.value, fs.admission_type.value, [...fs.grade.value as string[]].sort()]);
      if (keys.has(key)) add(`${p}.fields`, 'MATCH_KEY_DUPLICATE');
      keys.add(key);
    }
  });
  const failed = fields.some(f => f.state === 'failed'), known = fields.some(f => f.state === 'known');
  const status = run.change_status;
  if (['failed', 'partial'].includes(status) && run.failure === null) add('$.run.failure', 'FAILURE_DETAIL_REQUIRED');
  if (!['failed', 'partial'].includes(status) && run.failure !== null) add('$.run.failure', 'UNEXPECTED_FAILURE_DETAIL');
  if (status === 'failed' && (data.admissions.length > 0 || fields.some(f => f.state !== 'failed'))) add('$.run.change_status', 'FAILED_RUN_HAS_FACTS');
  if (status === 'partial' && (!failed || !known)) add('$.run.change_status', 'PARTIAL_REQUIRES_FACT_AND_FAILURE');
  if (['changed', 'unchanged'].includes(status) && failed) add('$.run.change_status', 'PARTIAL_STATUS_REQUIRED');
  if (status === 'unchanged' && run.comparison === null) add('$.run.comparison', 'COMPARISON_REQUIRED');
  if (run.comparison !== null && run.comparison.previous_crawl_id === run.crawl_id) add('$.run.comparison.previous_crawl_id', 'COMPARISON_SELF_REFERENCE');
  return result();
}

export function validateText(text: string): Result {
  try {
    const doc: Json = JSON.parse(text);
    function unicode(value: Json): void {
      if (typeof value === 'string') {
        for (const c of value) { const cp = c.codePointAt(0)!; if (cp >= 0xd800 && cp <= 0xdfff) throw new Error('Lone surrogate'); }
      } else if (Array.isArray(value)) value.forEach(unicode);
      else if (object(value)) for (const [k, v] of Object.entries(value)) { unicode(k); unicode(v); }
    }
    unicode(doc);
    // JSON.parse accepts duplicate object keys: tokenize the already valid JSON to reject them.
    const tokens = text.match(/"(?:\\.|[^"\\])*"|[{}\[\]:,]|[^{}\[\]:,\s]+/g)!;
    let index = 0;
    function check(depth: number): void {
      if (depth > 64) throw new Error('JSON depth');
      const token = tokens[index++];
      if (token === '{') {
        const seen = new Set<string>();
        while (tokens[index] !== '}') {
          const key: string = JSON.parse(tokens[index++]);
          if (seen.has(key)) throw new Error('Duplicate JSON key');
          seen.add(key); index++; check(depth + 1);
          if (tokens[index] === ',') index++;
        }
        index++;
      } else if (token === '[') {
        while (tokens[index] !== ']') { check(depth + 1); if (tokens[index] === ',') index++; }
        index++;
      } else if (/^-?[0-9]/.test(token) && !Number.isFinite(Number(token))) throw new Error('Nonfinite number');
    }
    check(0);
    return validate(doc);
  } catch {
    return { valid: false, errors: [{ path: '$', code: 'JSON_INVALID' }] };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = process.argv.slice(2);
  if (!files.length) { console.error('Usage: node scripts/validate-school-handoff-v2.ts FILE [FILE ...]'); process.exitCode = 2; }
  for (const file of files) {
    const result = validateText(readFileSync(file, 'utf8'));
    console.log(JSON.stringify({ sample: basename(file), ...result }));
    if (!result.valid) process.exitCode = 1;
  }
}
