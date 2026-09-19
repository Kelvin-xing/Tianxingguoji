import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {APIRequestContext} from 'playwright-core';
export async function assertTrialReferralSourceHttp({request,baseUrl,caseId}:{request:APIRequestContext;baseUrl:string;caseId:string}){
  const root=`${baseUrl}/api/v1/referral-sources`;
  const options={headers:{'idempotency-key':randomUUID()},data:{display_name:'Synthetic trial source',source_type:'website',description:null}};
  const created=await request.post(root,options);assert.equal(created.status(),201);
  const receipt=(await created.json()).data;
  assert.deepEqual((await (await request.post(root,options)).json()).data,receipt);
  const sourceId=receipt.referral_source.id;
  assert.equal((await request.get(`${root}/${sourceId}`)).status(),200);
  const updated=await request.patch(`${root}/${sourceId}`,{headers:{'idempotency-key':randomUUID()},data:{...options.data,display_name:'Synthetic updated source',expected_record_version:1}});
  assert.equal(updated.status(),200);
  const assignmentUrl=`${baseUrl}/api/v1/cases/${caseId}/referral-source-assignments`;
  const assignmentOptions={headers:{'idempotency-key':randomUUID()},data:{referral_source_id:sourceId,expected_current_assignment_record_version:null}};
  const assigned=await request.post(assignmentUrl,assignmentOptions);assert.equal(assigned.status(),200);
  assert.deepEqual((await (await request.post(assignmentUrl,assignmentOptions)).json()).data,(await assigned.json()).data);
  assert.equal((await (await request.get(assignmentUrl)).json()).data.current.referral_source_id,sourceId);
  const deactivated=await request.post(`${root}/${sourceId}/deactivate`,{headers:{'idempotency-key':randomUUID()},data:{expected_record_version:2,reason_code:'record.lifecycle.referral_source_deactivated'}});
  assert.equal(deactivated.status(),200);
  const after=await request.get(assignmentUrl);assert.equal(after.status(),200);
  assert.equal((await after.json()).data.current.referral_source_id,sourceId,'deactivation preserves existing case association');
  process.stdout.write(JSON.stringify({trial_referral_http:'pass',l1:'create_update_assign_deactivate',replay:'original_receipt',history:'preserved'})+'\n');
}
