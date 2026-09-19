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
  const reject=await request.post(decisionUrl,{headers:{'idempotency-key':randomUUID()},data:{decision:'reject',expected_record_version:2}});
  assert.equal(reject.status(),200);assert.equal((await reject.json()).data.status,'active');
  await requestDeletion(3);
  const options={headers:{'idempotency-key':randomUUID()},data:{decision:'approve',expected_record_version:4}};
  const approved=await request.post(decisionUrl,options);assert.equal(approved.status(),200);
  const receipt=(await approved.json()).data;assert.equal(receipt.status,'deleted');
  assert.deepEqual((await (await request.post(decisionUrl,options)).json()).data,receipt);
  await page.reload();await page.getByRole('heading',{name:'審查清單',exact:true}).waitFor();
  assert.equal(await page.getByText(label,{exact:true}).count(),0);
  assert.equal((await client.query('SELECT status,record_version FROM crm_guardians WHERE id=$1',[id])).rows[0].status,'deleted');
  process.stdout.write(JSON.stringify({trial_crm_deletion_http:'pass',l1:'request_reject_approve_replay',queue:'browser_reload',decision_ui:'not_implemented'})+'\n');
}
