import {expectArray,expectRecord,expectString,expectNullableString,requestApi} from '../../../lib/api/client.ts';
import type {SchoolChangeHistoryItem} from '../domain/change-history.ts';
import type {JsonValue} from '../domain/contract.ts';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function listSchoolChanges(schoolId:string,signal?:AbortSignal):Promise<readonly SchoolChangeHistoryItem[]>{
  if(!UUID.test(schoolId))return Promise.reject(new TypeError('Invalid school identity'));
  return requestApi({path:`/api/v1/schools/${schoolId}/change-requests`,signal},value=>{
    const root=expectRecord(value);keys(root,['items']);
    return expectArray(root.items,value=>{
      const row=expectRecord(value);
      keys(row,['change_request_id','school_id','revision_number','record_version','status','reason','submitted_at','approved_at','disabled_at','disable_reason','fields']);
      const change_request_id=expectString(row.change_request_id);
      if(!UUID.test(change_request_id)||row.school_id!==schoolId||!['candidate','approved','rejected','disabled'].includes(String(row.status)))throw new TypeError('Invalid school change');
      const fields=expectArray(row.fields,value=>{
        const field=expectRecord(value);keys(field,['field_name','field_class','snapshot_value','proposed_value','source_url','quote']);
        if(!['identity','general'].includes(String(field.field_class)))throw new TypeError('Invalid field class');
        return {field_name:expectString(field.field_name),field_class:field.field_class as 'identity'|'general',snapshot_value:field.snapshot_value as JsonValue,
          proposed_value:field.proposed_value as JsonValue,source_url:expectString(field.source_url),quote:expectString(field.quote)};
      });
      if(!fields.length)throw new TypeError('Missing change fields');
      return {change_request_id,school_id:schoolId,revision_number:positive(row.revision_number),record_version:positive(row.record_version),
        status:row.status as SchoolChangeHistoryItem['status'],reason:expectString(row.reason),submitted_at:timestamp(row.submitted_at),
        approved_at:row.approved_at===null?null:timestamp(row.approved_at),disabled_at:row.disabled_at===null?null:timestamp(row.disabled_at),disable_reason:expectNullableString(row.disable_reason),fields};
    });
  });
}
function keys(row:Readonly<Record<string,unknown>>,expected:readonly string[]){if(Object.keys(row).length!==expected.length||expected.some(key=>!Object.hasOwn(row,key)))throw new TypeError('Invalid school change fields');}
function timestamp(value:unknown){const text=expectString(value);if(!Number.isFinite(Date.parse(text)))throw new TypeError('Invalid time');return text;}
function positive(value:unknown):number{if(typeof value!=='number'||!Number.isSafeInteger(value)||value<1)throw new TypeError('Invalid version');return value;}
