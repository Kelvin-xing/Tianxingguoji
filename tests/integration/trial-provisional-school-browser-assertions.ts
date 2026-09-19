import assert from 'node:assert/strict';
import type {Page} from 'playwright-core';

export async function assertTrialProvisionalSchoolBrowser(page:Page,baseUrl:string){
  const endpoint=`${baseUrl}/api/v1/schools/provisionals`;
  await page.goto(`${baseUrl}/schools`);
  const panel=page.getByRole('region',{name:'未驗證學校',exact:true});
  await panel.getByRole('button',{name:'建立未驗證學校',exact:true}).click();
  await panel.getByText('請至少填寫中文或英文名稱。',{exact:true}).waitFor();
  await panel.getByRole('textbox',{name:'英文名稱',exact:true}).fill('Synthetic Browser Provisional');
  let key:string|undefined;
  await page.route(endpoint,async route=>{
    if(route.request().method()!=='POST'||key){await route.continue();return}
    key=route.request().headers()['idempotency-key'];
    const saved=await route.fetch();assert.equal(saved.status(),200);
    await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({api_version:'v1',request_id:'lost-provisional-ack',error:{code:'SERVICE_UNAVAILABLE',message:'Retry',retryable:true}})});
  });
  await panel.getByRole('button',{name:'建立未驗證學校',exact:true}).click();
  await panel.getByText('尚未確認保存結果。請重試原提交，避免重複建檔。',{exact:true}).waitFor();
  assert.equal(await panel.getByRole('textbox',{name:'英文名稱',exact:true}).isDisabled(),true);
  const replay=page.waitForResponse(response=>response.url()===endpoint&&response.request().method()==='POST'&&response.status()===200);
  await panel.getByRole('button',{name:'重試原提交',exact:true}).click();
  assert.equal((await replay).request().headers()['idempotency-key'],key);
  await panel.getByText('Synthetic Browser Provisional',{exact:true}).waitFor();
  assert.equal(await panel.getByText('Synthetic Browser Provisional',{exact:true}).count(),1);
  await page.unroute(endpoint);
  await page.reload();
  await panel.getByText('Synthetic Browser Provisional',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
  await panel.screenshot({path:'/tmp/access-trial-provisional-ui-mobile.png'});
  await panel.getByRole('textbox',{name:'中文名稱',exact:true}).fill('被拒絕建檔');
  await page.route(endpoint,async route=>{
    if(route.request().method()!=='POST'){await route.continue();return}
    await route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({api_version:'v1',request_id:'denied-provisional',error:{code:'FORBIDDEN',message:'Denied',retryable:false}})});
  });
  await panel.getByRole('button',{name:'建立未驗證學校',exact:true}).click();
  await page.getByText('登入狀態或學校存取權限已變更，請重新登入或聯絡管理員。',{exact:true}).waitFor();
  assert.equal(await page.getByRole('table').count(),0);
  assert.equal(await panel.count(),0);
  await page.unroute(endpoint);
  process.stdout.write(JSON.stringify({trial_provisional_school_browser:'pass',create:'english_name_only',lost_ack:'same_key_single_record',reload:'persisted',denied:'directory_cleared',viewport:390})+'\n');
}
