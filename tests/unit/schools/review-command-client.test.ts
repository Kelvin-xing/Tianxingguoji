import assert from 'node:assert/strict';
import test from 'node:test';
import {ApiClientError} from '../../../lib/api/client.ts';
import {reviewSchoolChangeRequest} from '../../../modules/schools/client.ts';
const school='51000000-0000-4000-8000-000000000401',change='51000000-0000-4000-8000-000000000402',resolved='51000000-0000-4000-8000-000000000403';
const command={decision:'approve' as const,expected_record_version:1,reason:'Synthetic'};
const receipt={school_id:school,change_request_id:change,overlay_revision_id:change,resolved_revision_id:resolved,status:'approved',record_version:2};
const envelope=(data:unknown)=>new Response(JSON.stringify({api_version:'v1',request_id:'review-test',data}),{headers:{'content-type':'application/json'}});
test('review client binds acknowledgement to the school, request, version and decision',async context=>{
  const original=globalThis.fetch;context.after(()=>{globalThis.fetch=original});
  globalThis.fetch=async(url,init)=>{assert.equal(url,`/api/v1/admin/schools/change-requests/${change}/reviews`);assert.equal(new Headers(init?.headers).get('idempotency-key'),'original-attempt');assert.deepEqual(JSON.parse(String(init?.body)),command);return envelope(receipt)};
  assert.deepEqual(await reviewSchoolChangeRequest(school,change,command,'original-attempt'),{status:'approved'});
});
test('review client rejects mismatched or incomplete receipts',async context=>{
  const original=globalThis.fetch;context.after(()=>{globalThis.fetch=original});
  for(const row of [{...receipt,school_id:change},{...receipt,change_request_id:school},{...receipt,overlay_revision_id:resolved},{...receipt,record_version:3},{...receipt,status:'rejected'},{...receipt,resolved_revision_id:null},{...receipt,resolved_revision_id:'bad'},{...receipt,secret:'leak'}]){
    globalThis.fetch=async()=>envelope(row);
    await assert.rejects(()=>reviewSchoolChangeRequest(school,change,command,'original-attempt'),error=>error instanceof ApiClientError&&error.code==='MALFORMED_RESPONSE');
  }
  globalThis.fetch=async()=>envelope({...receipt,status:'rejected',resolved_revision_id:null});
  assert.deepEqual(await reviewSchoolChangeRequest(school,change,{...command,decision:'reject'},'reject-attempt'),{status:'rejected'});
  globalThis.fetch=async()=>envelope({...receipt,status:'rejected'});
  await assert.rejects(()=>reviewSchoolChangeRequest(school,change,{...command,decision:'reject'},'reject-attempt'));
});
