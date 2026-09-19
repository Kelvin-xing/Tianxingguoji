import assert from 'node:assert/strict';
import test from 'node:test';
import {ApiClientError} from '../../../lib/api/client.ts';
import {listSchoolChanges} from '../../../modules/schools/client.ts';
const id='51000000-0000-4000-8000-000000000401';
const entry={change_request_id:'51000000-0000-4000-8000-000000000402',school_id:id,revision_number:1,record_version:1,status:'candidate',reason:'Synthetic',requester_name:'Synthetic colleague',allowed_actions:['approve','reject'],approval_block_reason:null,review:null,submitted_at:'2026-09-19T00:00:00.000Z',approved_at:null,disabled_at:null,disable_reason:null,
 fields:[{field_name:'phone',field_class:'general',snapshot_value:null,submitted_effective_value:{value:null},current_value:null,proposed_value:'Synthetic phone',source_url:'https://example.invalid/evidence',quote:'Synthetic evidence'}]};
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

test('validates review actions and decision history without inventing legacy facts',async context=>{
 const original=globalThis.fetch;context.after(()=>{globalThis.fetch=original});
 const review={decision:'reject',reviewer_name:'Synthetic reviewer',reviewer_role:'l1',reason:'Recheck',reviewed_at:'2026-09-19T01:00:00.000Z'};
 const rejected={...entry,status:'rejected',record_version:2,allowed_actions:[],review};
 globalThis.fetch=async()=>envelope([rejected]);
 assert.deepEqual(await listSchoolChanges(id),[rejected]);
 for(const row of [{...entry,allowed_actions:['disable']},{...entry,allowed_actions:['approve','approve']},{...entry,approval_block_reason:'missing_baseline'},{...entry,review},{...rejected,review:{...review,decision:'approve'}},{...rejected,review:{...review,reviewer_role:'admin'}},{...rejected,review:{...review,reviewed_at:'bad'}},{...rejected,review:{...review,token:'leak'}},{...entry,fields:[{...entry.fields[0],submitted_effective_value:{value:null,guessed:true}}]}]){
  globalThis.fetch=async()=>envelope([row]);
  await assert.rejects(()=>listSchoolChanges(id),error=>error instanceof ApiClientError&&error.code==='MALFORMED_RESPONSE');
 }
 const legacy={...entry,allowed_actions:['reject'],approval_block_reason:'missing_baseline',fields:[{...entry.fields[0],submitted_effective_value:null}]};
 globalThis.fetch=async()=>envelope([legacy]);
 assert.deepEqual(await listSchoolChanges(id),[legacy]);
});
