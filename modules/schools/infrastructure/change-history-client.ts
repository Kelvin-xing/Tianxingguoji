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
      keys(row,['change_request_id','school_id','revision_number','record_version','status','reason','requester_name','allowed_actions','approval_block_reason','review','submitted_at','approved_at','disabled_at','disable_reason','fields']);
      const change_request_id=expectString(row.change_request_id);
      if(!UUID.test(change_request_id)||row.school_id!==schoolId||!['candidate','approved','rejected','disabled'].includes(String(row.status)))throw new TypeError('Invalid school change');
      const fields=expectArray(row.fields,value=>{
        const field=expectRecord(value);keys(field,['field_name','field_class','snapshot_value','submitted_effective_value','current_value','proposed_value','source_url','quote']);
        if(!['identity','general'].includes(String(field.field_class)))throw new TypeError('Invalid field class');
        const submitted=field.submitted_effective_value===null?null:expectRecord(field.submitted_effective_value);
        if(submitted)keys(submitted,['value']);
        return {submitted_effective_value:submitted?{value:submitted.value as JsonValue}:null,field_name:expectString(field.field_name),field_class:field.field_class as 'identity'|'general',snapshot_value:field.snapshot_value as JsonValue,current_value:field.current_value as JsonValue,
          proposed_value:field.proposed_value as JsonValue,source_url:expectString(field.source_url),quote:expectString(field.quote)};
      });
      const actions=expectArray(row.allowed_actions,action=>{if(action!=='approve'&&action!=='reject')throw new TypeError('Invalid school action');return action;});
      if(new Set(actions).size!==actions.length||(row.status!=='candidate'&&actions.length)||!(row.approval_block_reason===null||row.approval_block_reason==='missing_baseline'||row.approval_block_reason==='baseline_changed')||(row.approval_block_reason!==null&&actions.includes('approve')))throw new TypeError('Invalid school review availability');
      let review:SchoolChangeHistoryItem['review']=null;
      if(row.review!==null){
        const receipt=expectRecord(row.review);keys(receipt,['reviewer_name','reviewer_role','decision','reason','reviewed_at']);
        if((receipt.reviewer_role!=='founder'&&receipt.reviewer_role!=='l1')||(receipt.decision!=='approve'&&receipt.decision!=='reject')||row.status==='candidate'||(row.status==='rejected'&&receipt.decision!=='reject')||(['approved','disabled'].includes(String(row.status))&&receipt.decision!=='approve'))throw new TypeError('Invalid school review receipt');
        review={reviewer_name:expectNullableString(receipt.reviewer_name),reviewer_role:receipt.reviewer_role,decision:receipt.decision,reason:expectString(receipt.reason),reviewed_at:timestamp(receipt.reviewed_at)};
      }
      if(!fields.length)throw new TypeError('Missing change fields');
      return {change_request_id,school_id:schoolId,revision_number:positive(row.revision_number),record_version:positive(row.record_version),
        requester_name:expectNullableString(row.requester_name),allowed_actions:actions,approval_block_reason:row.approval_block_reason,review,
        status:row.status as SchoolChangeHistoryItem['status'],reason:expectString(row.reason),submitted_at:timestamp(row.submitted_at),
        approved_at:row.approved_at===null?null:timestamp(row.approved_at),disabled_at:row.disabled_at===null?null:timestamp(row.disabled_at),disable_reason:expectNullableString(row.disable_reason),fields};
    });
  });
}
function keys(row:Readonly<Record<string,unknown>>,expected:readonly string[]){if(Object.keys(row).length!==expected.length||expected.some(key=>!Object.hasOwn(row,key)))throw new TypeError('Invalid school change fields');}
function timestamp(value:unknown){const text=expectString(value);if(!Number.isFinite(Date.parse(text)))throw new TypeError('Invalid time');return text;}
function positive(value:unknown):number{if(typeof value!=='number'||!Number.isSafeInteger(value)||value<1)throw new TypeError('Invalid version');return value;}
