import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {APIRequestContext} from 'playwright-core';

export async function assertTrialSchoolReviewHttp(input:{baseUrl:string;schoolId:string;l1ChangeId:string;l2ChangeId:string;founder:APIRequestContext;l1:APIRequestContext;l2:APIRequestContext}){
  const {baseUrl,schoolId,founder,l1,l2}=input;
  const reviews=(id:string)=>`${baseUrl}/api/v1/admin/schools/change-requests/${id}/reviews`;
  const command={decision:'approve',expected_record_version:1,reason:'Synthetic approval'};
  const options={headers:{'idempotency-key':randomUUID()},data:command};
  assert.equal((await l1.post(reviews(input.l1ChangeId),options)).status(),403);
  assert.equal((await l1.post(reviews(input.l1ChangeId),{headers:{'idempotency-key':randomUUID()},data:{...command,decision:'reject'}})).status(),403);
  assert.equal((await l2.post(reviews(input.l1ChangeId),options)).status(),403);
  assert.equal((await founder.post(reviews(input.l1ChangeId),{...options,data:{...command,reviewer_role:'founder'}})).status(),400);
  const approved=await founder.post(reviews(input.l1ChangeId),options);
  assert.equal(approved.status(),200);
  const receipt=(await approved.json()).data;
  assert.equal(receipt.status,'approved');assert.ok(receipt.resolved_revision_id);
  assert.deepEqual((await (await founder.post(reviews(input.l1ChangeId),options)).json()).data,receipt);
  const resolvedUrl=`${baseUrl}/api/v1/schools/${schoolId}/resolved`;
  const current=(await (await l1.get(resolvedUrl)).json()).data;
  assert.equal(current.fields.phone,'Synthetic reviewed phone');
  // A second pending supplement was confirmed against the old unknown value.
  assert.equal((await founder.post(reviews(input.l2ChangeId),{headers:{'idempotency-key':randomUUID()},data:command})).status(),409);
  const rejected=await founder.post(reviews(input.l2ChangeId),{headers:{'idempotency-key':randomUUID()},data:{...command,decision:'reject',reason:'Data has changed'}});
  assert.equal(rejected.status(),200);assert.equal((await rejected.json()).data.status,'rejected');
  const created=await founder.post(`${baseUrl}/api/v1/schools/${schoolId}/change-requests`,{headers:{'idempotency-key':randomUUID()},data:{field_name:'phone',field_class:'general',base_snapshot_id:current.base_snapshot_id,
    base_value_sha256:current.change_context.base_value_hashes.phone??current.change_context.empty_value_sha256,
    expected_effective_value_sha256:current.change_context.effective_value_hashes.phone,
    proposed_value:'Synthetic L1-approved phone',reason:'Synthetic updated source',evidence:{source_url:'https://example.invalid/school',quote:'Synthetic new phone'}}});
  assert.equal(created.status(),200);
  const id=(await created.json()).data.change_request_id;
  const concurrent=await Promise.all([1,2].map(()=>l1.post(reviews(id),{headers:{'idempotency-key':randomUUID()},data:command})));
  assert.deepEqual(concurrent.map(response=>response.status()).sort(),[200,409]);
  assert.equal((await concurrent.find(response=>response.status()===200)!.json()).data.status,'approved');
  assert.equal((await (await l1.get(resolvedUrl)).json()).data.fields.phone,'Synthetic L1-approved phone');
  process.stdout.write(JSON.stringify({trial_school_review_http:'pass',reviewers:'actual_founder_l1',self_review:'denied',l2:'denied',outdated:'409',rejection:'recorded',replay:'original_receipt',concurrent:'single_approval'})+'\n');
}
