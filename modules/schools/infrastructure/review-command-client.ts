import {expectNullableString,expectRecord,expectString,requestApi} from '../../../lib/api/client.ts';
export interface SchoolReviewInput {readonly decision:'approve'|'reject';readonly expected_record_version:number;readonly reason:string}
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function reviewSchoolChangeRequest(schoolId:string,changeId:string,input:SchoolReviewInput,key:string){
  return requestApi({path:`/api/v1/admin/schools/change-requests/${encodeURIComponent(changeId)}/reviews`,method:'POST',idempotencyKey:key,body:{...input}},value=>{
    const row=expectRecord(value),expected=['change_request_id','school_id','overlay_revision_id','resolved_revision_id','status','record_version'];
    const resolved=expectNullableString(row.resolved_revision_id),status=expectString(row.status);
    if(Object.keys(row).length!==expected.length||expected.some(key=>!Object.hasOwn(row,key))||row.school_id!==schoolId||row.change_request_id!==changeId||row.overlay_revision_id!==changeId
      ||row.record_version!==input.expected_record_version+1||status!==(input.decision==='approve'?'approved':'rejected')
      ||(input.decision==='approve'?resolved===null||!UUID.test(resolved):resolved!==null))throw new TypeError('Invalid school review receipt');
    return {status};
  });
}
