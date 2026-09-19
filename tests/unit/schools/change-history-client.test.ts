import assert from 'node:assert/strict';
import test from 'node:test';
import {ApiClientError} from '../../../lib/api/client.ts';
import {listSchoolChanges} from '../../../modules/schools/client.ts';
const id='51000000-0000-4000-8000-000000000401';
const entry={change_request_id:'51000000-0000-4000-8000-000000000402',school_id:id,revision_number:1,record_version:1,status:'candidate',reason:'Synthetic',submitted_at:'2026-09-19T00:00:00.000Z',approved_at:null,disabled_at:null,disable_reason:null,
 fields:[{field_name:'phone',field_class:'general',snapshot_value:null,proposed_value:'Synthetic phone',source_url:'https://example.invalid/evidence',quote:'Synthetic evidence'}]};
const envelope=(items:unknown[])=>new Response(JSON.stringify({api_version:'v1',request_id:'history-test',data:{items}}),{headers:{'content-type':'application/json'}});
test('reads school-bound pending and processed history without internal actor fields',async context=>{
 const original=globalThis.fetch;context.after(()=>{globalThis.fetch=original});
 globalThis.fetch=async(url)=>{assert.equal(url,`/api/v1/schools/${id}/change-requests`);return envelope([entry])};
 assert.deepEqual(await listSchoolChanges(id),[entry]);
});
test('rejects wrong school, unexpected fields, missing fields, invalid status, version or time',async context=>{
 const original=globalThis.fetch;context.after(()=>{globalThis.fetch=original});
 for(const row of [{...entry,school_id:entry.change_request_id},{...entry,requested_by_user_id:id},{...entry,fields:[]},{...entry,status:'made_up'},{...entry,record_version:0},{...entry,submitted_at:'bad'}, {...entry,fields:[{...entry.fields[0],actor_token:'leak'}]}]){
  globalThis.fetch=async()=>envelope([row]);
  await assert.rejects(()=>listSchoolChanges(id),error=>error instanceof ApiClientError&&error.code==='MALFORMED_RESPONSE');
 }
});
