import assert from 'node:assert/strict';
import test from 'node:test';
import {getResolvedSchool} from '../../../modules/schools/client.ts';
import {ApiClientError} from '../../../lib/api/client.ts';
const id='51000000-0000-4000-8000-000000000401';
test('resolved client accepts the actual endpoint without a top-level source key and rejects identity mismatch',async context=>{
  const original=globalThis.fetch;context.after(()=>{globalThis.fetch=original});
  let currentId=id;
  globalThis.fetch=async()=>new Response(JSON.stringify({api_version:'v1',request_id:'resolved-test',data:{school_id:currentId,base_snapshot_id:id,resolved_revision_id:null,overlay_revision_id:null,resolution_sha256:'a'.repeat(64),fields:{school_name_en:'Synthetic'},provenance:{},conflicts:[]}}),{headers:{'content-type':'application/json'}});
  assert.equal((await getResolvedSchool(id)).fields.school_name_en,'Synthetic');
  currentId='51000000-0000-4000-8000-000000000402';
  await assert.rejects(()=>getResolvedSchool(id),error=>error instanceof ApiClientError&&error.code==='MALFORMED_RESPONSE');
});
