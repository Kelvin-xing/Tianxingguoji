import assert from 'node:assert/strict';
import test from 'node:test';
import {ApiClientError} from '../../../lib/api/client.ts';
import {submitSchoolChangeRequest,schoolChangeFailure,type SchoolChangeInput} from '../../../modules/schools/client.ts';
const id='51000000-0000-4000-8000-000000000401';
const command:SchoolChangeInput={field_name:'phone',field_class:'general',base_snapshot_id:id,base_value_sha256:'a'.repeat(64),expected_effective_value_sha256:'b'.repeat(64),proposed_value:'Synthetic',reason:'Synthetic reason',evidence:{source_url:'https://example.invalid/source',quote:'Synthetic evidence'}};
const receipt={change_request_id:'51000000-0000-4000-8000-000000000402',school_id:id,base_snapshot_id:id,field_name:'phone',status:'submitted',record_version:1};
const envelope=(data:unknown)=>new Response(JSON.stringify({api_version:'v1',request_id:'change-test',data}),{headers:{'content-type':'application/json'}});
test('sends the frozen change and key and requires a bound pending receipt',async context=>{
 const original=globalThis.fetch;context.after(()=>{globalThis.fetch=original});
 globalThis.fetch=async(url,init)=>{assert.equal(url,`/api/v1/schools/${id}/change-requests`);assert.equal(new Headers(init?.headers).get('idempotency-key'),'same-attempt');assert.deepEqual(JSON.parse(String(init?.body)),command);return envelope(receipt)};
 assert.deepEqual(await submitSchoolChangeRequest(id,command,'same-attempt'),{change_request_id:receipt.change_request_id});
});
test('does not accept a receipt for another school, field, baseline or an approved result',async context=>{
 const original=globalThis.fetch;context.after(()=>{globalThis.fetch=original});
 for(const data of [{...receipt,school_id:receipt.change_request_id},{...receipt,field_name:'district'},{...receipt,base_snapshot_id:receipt.change_request_id},{...receipt,status:'approved'},{...receipt,record_version:2},{...receipt,secret:'leak'}]){
  globalThis.fetch=async()=>envelope(data);
  await assert.rejects(()=>submitSchoolChangeRequest(id,command,'same-attempt'),error=>error instanceof ApiClientError&&error.code==='MALFORMED_RESPONSE');
 }
});
test('distinguishes revoked access, conflicts and unknown outcomes for safe retries',()=>{
 for(const [status,expected] of [[401,'denied'],[403,'denied'],[404,'conflict'],[409,'conflict'],[422,'validation'],[503,'unknown']] as const){
  assert.equal(schoolChangeFailure(new ApiClientError({status,code:'TEST',requestId:null,retryable:false})),expected);
 }
});
