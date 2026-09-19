import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {Client} from 'pg';
import type {Page} from 'playwright-core';
import {seedSyntheticNotice} from './trial-notification-read-assertions.ts';

export async function assertTrialNotificationBrowser(input:{client:Client;page:Page;baseUrl:string;organizationId:string;userId:string;otherUserId:string}):Promise<void>{
  const {client,page,baseUrl,organizationId:org,userId}=input;
  const notice=await seedSyntheticNotice(client,org,userId);
  const foreign=await seedSyntheticNotice(client,org,input.otherUserId);
  const root=baseUrl+'/api/v1/notifications';
  assert.equal((await page.request.post(`${root}/${foreign}/resolve-target`,{data:{}})).status(),404);
  assert.equal((await page.request.post(`${root}/${foreign}/read`,{headers:{'idempotency-key':randomUUID()},data:{expected_record_version:1}})).status(),404);
  assert.equal((await page.request.get(`${root}/unread-count`)).status(),200);
  const lookup=await page.request.post(`${root}/${notice}/resolve-target`,{data:{}});
  assert.equal(lookup.status(),200);assert.equal((await lookup.json()).data.route_code,'TASK_PENDING_ITEM');
  const writes:Array<{key:string;body:string|null}>=[];
  await page.route(`${root}/${notice}/read`,async route=>{
    writes.push({key:route.request().headers()['idempotency-key']!,body:route.request().postData()});
    const response=await route.fetch();assert.equal(response.status(),200);
    if(writes.length===1)await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'SERVICE_UNAVAILABLE',message:'Synthetic lost acknowledgement',request_id:'notice-lost'}})});
    else await route.fulfill({response});
  });
  await page.goto(baseUrl+'/notifications');
  await page.getByText('有待處理事項',{exact:true}).waitFor();
  await page.getByRole('button',{name:'標記為已讀',exact:true}).click();
  await page.getByRole('button',{name:'重試已讀操作',exact:true}).click();
  await page.getByText('已讀',{exact:true}).waitFor();
  assert.equal(writes.length,2);assert.deepEqual(writes[0],writes[1]);
  assert.equal(Number((await client.query('SELECT record_version FROM notifications_notifications WHERE id=$1',[notice])).rows[0].record_version),2);
  await page.reload();await page.getByText('已讀',{exact:true}).waitFor();
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
  await page.screenshot({path:'/tmp/access-trial-notifications-mobile.png',fullPage:true});
  await page.getByRole('button',{name:'開啟',exact:true}).click();
  await page.waitForURL('**/tasks');
  await page.goto(baseUrl+'/notifications');
  await page.route(`${root}/${notice}/resolve-target`,async route=>route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({error:{code:'FORBIDDEN',message:'Synthetic denied',request_id:'notice-denied'}})}));
  await page.getByRole('button',{name:'開啟',exact:true}).click();
  await page.getByText('無法查看通知',{exact:true}).waitFor();
  assert.equal(await page.getByText('有待處理事項',{exact:true}).count(),0);
  await page.unroute(`${root}/${notice}/resolve-target`);await page.unroute(`${root}/${notice}/read`);
  process.stdout.write(JSON.stringify({trial_notification_browser:'pass',l3_open:'tasks',lost_ack:'same_key_one_version',foreign:'404',denied:'cleared',viewport:390})+'\n');
}
