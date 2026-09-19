import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {APIRequestContext,Page} from 'playwright-core';
import type {Client} from 'pg';
export async function assertTrialCrmDeletionHttp(input:{page:Page;request:APIRequestContext;baseUrl:string;client:Client;studentId:string}) {
  const {page,request,baseUrl,client,studentId}=input;
  const id=randomUUID(),label=`Synthetic deletion ${randomUUID()}`;
  await client.query(`INSERT INTO crm_guardians(id,organization_id,display_name,email,status)
    SELECT $1,organization_id,$2,'deletion@example.invalid','active' FROM crm_students WHERE id=$3`,[id,label,studentId]);
  const url=`${baseUrl}/api/v1/guardians/${id}/deletion-requests`;
  const requestDeletion=async(version:number)=>{
    const options={headers:{'idempotency-key':randomUUID()},data:{expected_record_version:version,reason_code:'record.lifecycle.pending_delete_requested'}};
    const response=await request.post(url,options);assert.equal(response.status(),200);
    assert.deepEqual((await (await request.post(url,options)).json()).data,(await response.json()).data);
  };
  await requestDeletion(1);
  await page.goto(`${baseUrl}/students/deletion-requests`);
  await page.getByText(label,{exact:true}).waitFor();
  await page.reload();await page.getByText(label,{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
  await page.screenshot({path:'/tmp/access-trial-deletion-queue-mobile.png',fullPage:true});
  const queueUrl=`${baseUrl}/api/v1/crm/deletion-requests`;
  const queue=await request.get(queueUrl);assert.equal(queue.status(),200);
  const payload=(await queue.json()).data;
  const items=Array.isArray(payload)?payload:payload.requests;
  const row=items.find((item:{entity_id:string})=>item.entity_id===id);assert.ok(row);
  const decisionUrl=`${queueUrl}/${row.request_id}/decisions`;
  await page.getByRole('button',{name:'駁回申請',exact:true}).click();
  await page.getByLabel('我已核對並確認駁回申請。',{exact:true}).check();
  const rejected=page.waitForResponse(response=>response.url()===decisionUrl&&response.request().method()==='POST');
  await page.getByRole('button',{name:'確認駁回',exact:true}).click();
  const reject=await rejected;assert.equal(reject.status(),200);assert.equal((await reject.json()).data.status,'active');
  await page.getByText('審查決定已保存。',{exact:true}).waitFor();
  await page.getByText(label,{exact:true}).waitFor({state:'hidden'});
  await requestDeletion(3);
  await page.reload();await page.getByText(label,{exact:true}).waitFor();
  await page.getByRole('button',{name:'批准刪除',exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'確認批准',exact:true}).isDisabled(),true);
  await page.getByLabel('我已核對並確認批准刪除。',{exact:true}).check();
  assert.equal(await page.getByRole('combobox').isDisabled(),true);
  await page.screenshot({path:'/tmp/access-trial-decision-confirm-mobile.png',fullPage:true});
  let originalKey:string|undefined;
  await page.route(decisionUrl,async route=>{
    if(originalKey){await route.continue();return}
    originalKey=route.request().headers()['idempotency-key'];
    const committed=await route.fetch();assert.equal(committed.status(),200);
    await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({api_version:'v1',request_id:'lost-deletion-ack',error:{code:'SERVICE_UNAVAILABLE',message:'Retry',retryable:true}})});
  });
  await page.getByRole('button',{name:'確認批准',exact:true}).click();
  await page.getByText('暫時無法確認處理結果。請重試原決定，系統不會重複處理。',{exact:true}).waitFor();
  const approvedResponse=page.waitForResponse(response=>response.url()===decisionUrl&&response.status()===200);
  await page.getByRole('button',{name:'重試原決定',exact:true}).click();
  const approved=await approvedResponse;assert.equal(approved.request().headers()['idempotency-key'],originalKey);
  await page.unroute(decisionUrl);
  const options={headers:{'idempotency-key':originalKey!},data:{decision:'approve',expected_record_version:4}};
  const receipt=(await approved.json()).data;assert.equal(receipt.status,'deleted');
  assert.deepEqual((await (await request.post(decisionUrl,options)).json()).data,receipt);
  await page.reload();await page.getByRole('heading',{name:'審查清單',exact:true}).waitFor();
  assert.equal(await page.getByText(label,{exact:true}).count(),0);
  assert.equal((await client.query('SELECT status,record_version FROM crm_guardians WHERE id=$1',[id])).rows[0].status,'deleted');
  // Reuse a rejected synthetic record to exercise a stale page and an authorization denial.
  const staleId=randomUUID();
  await client.query(`INSERT INTO crm_guardians(id,organization_id,display_name,email,status)
    SELECT $1,organization_id,'Synthetic stale review','stale-review@example.invalid','active' FROM crm_students WHERE id=$2`,[staleId,studentId]);
  assert.equal((await request.post(`${baseUrl}/api/v1/guardians/${staleId}/deletion-requests`,{headers:{'idempotency-key':randomUUID()},data:{expected_record_version:1,reason_code:'record.lifecycle.pending_delete_requested'}})).status(),200);
  await page.reload();await page.getByText('Synthetic stale review',{exact:true}).waitFor();
  const staleQueue=(await (await request.get(queueUrl)).json()).data;
  const staleRow=staleQueue.find((item:{entity_id:string})=>item.entity_id===staleId);
  const staleUrl=`${queueUrl}/${staleRow.request_id}/decisions`;
  // Another valid reviewer resolves the request after the page loaded.
  assert.equal((await request.post(staleUrl,{headers:{'idempotency-key':randomUUID()},data:{decision:'reject',expected_record_version:2}})).status(),200);
  await page.getByRole('button',{name:'批准刪除',exact:true}).click();
  await page.getByLabel('我已核對並確認批准刪除。',{exact:true}).check();
  await page.getByRole('button',{name:'確認批准',exact:true}).click();
  await page.getByText('資料或申請狀態已變更，請重新載入後再審查。',{exact:true}).waitFor();
  await page.getByRole('button',{name:'重新載入審查清單',exact:true}).click();
  await page.getByText('Synthetic stale review',{exact:true}).waitFor({state:'hidden'});
  assert.equal((await request.post(`${baseUrl}/api/v1/guardians/${staleId}/deletion-requests`,{headers:{'idempotency-key':randomUUID()},data:{expected_record_version:3,reason_code:'record.lifecycle.pending_delete_requested'}})).status(),200);
  await page.reload();await page.getByText('Synthetic stale review',{exact:true}).waitFor();
  await page.route(staleUrl,route=>route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({api_version:'v1',request_id:'denied-review',error:{code:'FORBIDDEN',message:'Denied',retryable:false}})}));
  await page.getByRole('button',{name:'駁回申請',exact:true}).click();
  await page.getByLabel('我已核對並確認駁回申請。',{exact:true}).check();
  await page.getByRole('button',{name:'確認駁回',exact:true}).click();
  await page.getByText('無法查看待刪除審查',{exact:true}).waitFor();
  assert.equal(await page.getByText('Synthetic stale review',{exact:true}).count(),0);
  await page.unroute(staleUrl);
  process.stdout.write(JSON.stringify({trial_crm_deletion_http:'pass',l1:'request_reject_approve_replay',queue:'browser_reload',decision_ui:'reject_approve_lost_ack_retry'})+'\n');
}
