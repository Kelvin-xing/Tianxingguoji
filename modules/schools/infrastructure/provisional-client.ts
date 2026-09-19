import {ApiClientError,expectArray,expectNullableString,expectRecord,expectString,requestApi} from '../../../lib/api/client.ts';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export interface ProvisionalSchool {
  school_id:string; school_name_zh:string|null; school_name_en:string|null;
  district:string|null; system:string|null; stage:string|null; reason:string|null;
  status:'provisional'; record_version:1; created_at:string;
}
export function listProvisionalSchools(signal?:AbortSignal):Promise<readonly ProvisionalSchool[]>{
  return requestApi({path:'/api/v1/schools/provisionals',signal},value=>{
    const root=expectRecord(value);exactKeys(root,['items']);
    return expectArray(root.items,item=>{
      const row=expectRecord(item);
      exactKeys(row,['school_id','school_name_zh','school_name_en','district','system','stage','reason','status','record_version','created_at']);
      const receipt=decodeReceipt({school_id:row.school_id,status:row.status,record_version:row.record_version});
      const school_name_zh=expectNullableString(row.school_name_zh),school_name_en=expectNullableString(row.school_name_en);
      const created_at=expectString(row.created_at);
      if(!(school_name_zh?.trim()||school_name_en?.trim())||!Number.isFinite(Date.parse(created_at)))throw new TypeError('Invalid provisional school');
      return {...receipt,school_name_zh,school_name_en,district:expectNullableString(row.district),system:expectNullableString(row.system),
        stage:expectNullableString(row.stage),reason:expectNullableString(row.reason),created_at};
    });
  });
}
export function createProvisionalSchoolRecord(input:{school_name_zh:string|null;school_name_en:string|null},key:string){
  if(!(input.school_name_zh?.trim()||input.school_name_en?.trim())||[input.school_name_zh,input.school_name_en].some(value=>value!==null&&(typeof value!=='string'||value.trim().length>512))){
    return Promise.reject(new ApiClientError({code:'INVALID_CLIENT_REQUEST',status:0,retryable:false,requestId:null}));
  }
  return requestApi({path:'/api/v1/schools/provisionals',method:'POST',idempotencyKey:key,body:{school_name_zh:input.school_name_zh?.trim()||null,school_name_en:input.school_name_en?.trim()||null}},decodeReceipt);
}
export function provisionalAccessDenied(error:unknown):boolean{return error instanceof ApiClientError&&(error.status===401||error.status===403);}
export function provisionalValidationFailure(error:unknown):boolean{return error instanceof ApiClientError&&(error.status===400||error.status===422||error.code==='INVALID_CLIENT_REQUEST');}
function decodeReceipt(value:unknown){
  const row=expectRecord(value);exactKeys(row,['school_id','status','record_version']);
  const school_id=expectString(row.school_id);
  if(!UUID.test(school_id)||row.status!=='provisional'||row.record_version!==1)throw new TypeError('Invalid provisional receipt');
  return {school_id,status:'provisional' as const,record_version:1 as const};
}
function exactKeys(row:Readonly<Record<string,unknown>>,keys:readonly string[]){
  if(Object.keys(row).length!==keys.length||keys.some(key=>!Object.hasOwn(row,key)))throw new TypeError('Invalid provisional fields');
}
