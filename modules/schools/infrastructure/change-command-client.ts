import {ApiClientError,expectRecord,expectString,requestApi} from '../../../lib/api/client.ts';
export interface SchoolChangeInput {
  readonly field_name:string;readonly field_class:'identity'|'general';readonly base_snapshot_id:string;
  readonly base_value_sha256:string;readonly proposed_value:string;readonly reason:string;
  readonly evidence:{readonly source_url:string;readonly quote:string};
}
export function submitSchoolChangeRequest(schoolId:string,input:SchoolChangeInput,key:string){
  return requestApi({path:`/api/v1/schools/${encodeURIComponent(schoolId)}/change-requests`,method:'POST',idempotencyKey:key,body:{...input,evidence:{...input.evidence}}},value=>{
    const row=expectRecord(value),expected=['change_request_id','school_id','base_snapshot_id','field_name','status','record_version'];
    const id=expectString(row.change_request_id);
    if(Object.keys(row).length!==expected.length||expected.some(key=>!Object.hasOwn(row,key))||! /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
      ||row.school_id!==schoolId||row.base_snapshot_id!==input.base_snapshot_id||row.field_name!==input.field_name||row.status!=='submitted'||row.record_version!==1)throw new TypeError('Invalid school change receipt');
    return {change_request_id:id};
  });
}
export function schoolChangeFailure(error:unknown):'denied'|'conflict'|'validation'|'unknown'{
  if(!(error instanceof ApiClientError))return 'unknown';
  if(error.status===401||error.status===403)return 'denied';
  if(error.status===409||error.status===404)return 'conflict';
  if(error.status===400||error.status===422)return 'validation';
  return 'unknown';
}
