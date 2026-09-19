import assert from 'node:assert/strict';
import type {Page} from 'playwright-core';
export async function assertTrialSchoolChangeForm(page:Page,baseUrl:string,schoolId:string){
  const endpoint=`${baseUrl}/api/v1/schools/${schoolId}/change-requests`;
  await page.goto(`${baseUrl}/schools/${schoolId}`);
  await page.getByRole('button',{name:'補充電話',exact:true}).click();
  const form=page.getByRole('form',{name:'電話變更申請',exact:true});
  await form.getByRole('button',{name:'提交審批',exact:true}).click();
  await form.getByText('請填寫申請值、理由及證據摘要。',{exact:true}).waitFor();
  await form.getByLabel('申請值',{exact:true}).fill('Synthetic UI phone');
  await form.getByLabel('申請理由',{exact:true}).fill('Synthetic UI supplement');
  await form.getByLabel('證據來源網址',{exact:true}).fill('https://example.invalid/school');
  await form.getByLabel('證據摘要',{exact:true}).fill('Synthetic UI evidence');
  await form.screenshot({path:'/tmp/access-trial-school-change-form-mobile.png'});
  let key:string|undefined;
  await page.route(endpoint,async route=>{
    if(route.request().method()!=='POST'||key){await route.continue();return}
    key=route.request().headers()['idempotency-key'];
    const committed=await route.fetch();assert.equal(committed.status(),200);
    await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({api_version:'v1',request_id:'lost-school-change',error:{code:'SERVICE_UNAVAILABLE',message:'Retry',retryable:true}})});
  });
  await form.getByRole('button',{name:'提交審批',exact:true}).click();
  await form.getByText('尚未確認提交結果。請重試原申請，避免重複提交。',{exact:true}).waitFor();
  assert.equal(await form.getByLabel('申請值',{exact:true}).isDisabled(),true);
  assert.equal(await page.getByRole('button',{name:'重新載入學校資料',exact:true}).isDisabled(),true);
  const replay=page.waitForResponse(response=>response.url()===endpoint&&response.request().method()==='POST'&&response.status()===200);
  await form.getByRole('button',{name:'重試原申請',exact:true}).click();
  assert.equal((await replay).request().headers()['idempotency-key'],key);
  const pending=page.getByRole('region',{name:'待處理更新',exact:true});
  await pending.getByText('申請值：Synthetic UI phone',{exact:true}).waitFor();
  assert.equal(await pending.getByText('申請值：Synthetic UI phone',{exact:true}).count(),1);
  assert.equal(await page.getByRole('region',{name:'基礎資料',exact:true}).getByText('Synthetic UI phone',{exact:true}).count(),0);
  await page.unroute(endpoint);
  await page.reload();await pending.getByText('申請值：Synthetic UI phone',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
  await page.getByRole('button',{name:'補充電話',exact:true}).click();
  await form.getByLabel('申請值',{exact:true}).fill('Denied phone');
  await form.getByLabel('申請理由',{exact:true}).fill('Synthetic denied request');
  await form.getByLabel('證據來源網址',{exact:true}).fill('https://example.invalid/school');
  await form.getByLabel('證據摘要',{exact:true}).fill('Synthetic evidence');
  await page.route(endpoint,async route=>{
    if(route.request().method()!=='POST'){await route.continue();return}
    await route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({api_version:'v1',request_id:'denied-school-change',error:{code:'FORBIDDEN',message:'Denied',retryable:false}})});
  });
  await form.getByRole('button',{name:'提交審批',exact:true}).click();
  await page.getByText('登入狀態或學校存取權限已變更，請重新登入或聯絡管理員。',{exact:true}).waitFor();
  assert.equal(await pending.count(),0);
  await page.unroute(endpoint);
  process.stdout.write(JSON.stringify({trial_school_change_form:'pass',submit:'pending_only',lost_ack:'same_key_single_request',reload:'persisted',denial:'cleared',viewport:390})+'\n');
}
