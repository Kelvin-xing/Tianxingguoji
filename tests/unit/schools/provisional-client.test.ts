import assert from 'node:assert/strict';
import test from 'node:test';
import {ApiClientError} from '../../../lib/api/client.ts';
import {createProvisionalSchoolRecord,listProvisionalSchools} from '../../../modules/schools/client.ts';
const id='10000000-0000-4000-8000-000000000001';
const receipt={school_id:id,status:'provisional',record_version:1};
const item={...receipt,school_name_zh:null,school_name_en:'Synthetic',district:null,system:null,stage:null,reason:null,created_at:'2026-09-19T00:00:00.000Z'};
const envelope=(data:unknown)=>new Response(JSON.stringify({api_version:'v1',request_id:'provisional-client-test',data}),{status:200,headers:{'content-type':'application/json'}});

test('minimal school creation preserves names and idempotency and reads explicit unknown fields',async context=>{
  const original=globalThis.fetch;context.after(()=>{globalThis.fetch=original});
  let calls=0;
  globalThis.fetch=async (url,init)=>{
    calls++;assert.equal(url,'/api/v1/schools/provisionals');
    if(init?.method==='POST'){
      assert.equal(new Headers(init.headers).get('idempotency-key'),'same-school-attempt');
      assert.deepEqual(JSON.parse(String(init.body)),{school_name_zh:null,school_name_en:'Synthetic'});
      return envelope(receipt);
    }
    return envelope({items:[item]});
  };
  assert.deepEqual(await createProvisionalSchoolRecord({school_name_zh:null,school_name_en:' Synthetic '},'same-school-attempt'),receipt);
  assert.deepEqual(await listProvisionalSchools(),[item]);assert.equal(calls,2);
});

test('empty names are rejected before network and invalid receipts are never treated as success',async context=>{
  const original=globalThis.fetch;context.after(()=>{globalThis.fetch=original});let calls=0;
  globalThis.fetch=async()=>{calls++;return envelope({...receipt,status:'verified'})};
  await assert.rejects(()=>createProvisionalSchoolRecord({school_name_zh:' ',school_name_en:null},'attempt'),error=>error instanceof ApiClientError&&error.code==='INVALID_CLIENT_REQUEST');
  assert.equal(calls,0);
  await assert.rejects(()=>createProvisionalSchoolRecord({school_name_zh:null,school_name_en:'Synthetic'},'attempt'),error=>error instanceof ApiClientError&&error.code==='MALFORMED_RESPONSE');
});

test('provisional reads reject leaked fields, missing names and false verification status',async context=>{
  const original=globalThis.fetch;context.after(()=>{globalThis.fetch=original});
  for(const invalid of [{...item,secret:'leak'},{...item,school_name_en:null},{...item,status:'verified'},{...item,created_at:'invalid'}]){
    globalThis.fetch=async()=>envelope({items:[invalid]});
    await assert.rejects(()=>listProvisionalSchools(),error=>error instanceof ApiClientError&&error.code==='MALFORMED_RESPONSE');
  }
});
