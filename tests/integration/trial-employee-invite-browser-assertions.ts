import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {Browser} from 'playwright-core';
import type {Client} from 'pg';

export async function assertTrialInviteBrowser(input:{browser:Browser;baseUrl:string;cookie:string;client:Client}):Promise<void>{
  const context=await input.browser.newContext({baseURL:input.baseUrl});
  try{
    const split=input.cookie.indexOf('=');
    await context.addCookies([{name:input.cookie.slice(0,split),value:input.cookie.slice(split+1),url:input.baseUrl,httpOnly:true,sameSite:'Lax'}]);
    const page=await context.newPage();
    await page.goto('/admin/access');
    await page.getByRole('button',{name:'邀請使用者',exact:true}).click();
    const dialog=page.getByRole('dialog');
    const level=dialog.getByLabel('員工等級',{exact:true});
    await level.waitFor({state:'visible'});
    assert.deepEqual(await level.locator('option').evaluateAll(nodes=>nodes.map(node=>(node as HTMLOptionElement).value)),['founder','l1','l2','l3']);
    const email=`browser-trial-${randomUUID()}@example.test.invalid`;
    await dialog.getByLabel('公司電郵',{exact:true}).fill(email);
    await dialog.getByLabel('暱稱（可稍後由對方設定）',{exact:true}).fill('Synthetic trial invitation');
    await level.selectOption('l2');
    await dialog.getByRole('checkbox',{name:'國際學校',exact:true}).check();
    await dialog.getByRole('checkbox',{name:'本地學校',exact:true}).check();
    await dialog.getByText('兼職',{exact:true}).click();
    assert.equal(await dialog.getByRole('radio',{name:'兼職',exact:true}).isChecked(),true);
    await page.setViewportSize({width:390,height:844});
    await page.screenshot({path:'/tmp/access-trial-invite-mobile.png',fullPage:true});
    const overflow=await page.evaluate(()=>({width:window.innerWidth,scroll:document.documentElement.scrollWidth,
      elements:[...document.querySelectorAll('body *')].filter(element=>element.getBoundingClientRect().right>window.innerWidth+1)
        .slice(0,12).map(element=>({tag:element.tagName,class:element.getAttribute('class'),right:element.getBoundingClientRect().right,position:getComputedStyle(element).position}))}));
    assert.ok(overflow.scroll<=overflow.width,JSON.stringify(overflow));
    const submitted:Array<{key:string;body:string|null}>=[];
    await page.route('**/api/v1/auth/invites',async route=>{
      submitted.push({key:route.request().headers()['idempotency-key']!,body:route.request().postData()});
      const result=await route.fetch();assert.equal(result.status(),200);
      if(submitted.length===1) await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'SERVICE_UNAVAILABLE',message:'Synthetic lost acknowledgement',request_id:'synthetic-lost'}})});
      else await route.fulfill({response:result});
    });
    const response=page.waitForResponse(r=>r.url().endsWith('/api/v1/auth/invites')&&r.request().method()==='POST');
    await dialog.getByRole('button',{name:'發送邀請',exact:true}).click();
    assert.equal((await response).status(),503);
    await dialog.getByRole('button',{name:'確認邀請結果',exact:true}).waitFor();
    assert.equal(await dialog.getByLabel('公司電郵',{exact:true}).isDisabled(),true);
    await dialog.getByRole('button',{name:'確認邀請結果',exact:true}).click();
    await dialog.waitFor({state:'detached'});
    assert.equal(submitted.length,2);assert.deepEqual(submitted[0],submitted[1]);
    const row=page.getByRole('row').filter({has:page.getByText(email,{exact:true})});
    await row.getByText('已邀請',{exact:true}).waitFor();
    await page.reload();
    await row.getByText('L2',{exact:true}).waitFor();
    assert.equal(await row.getByRole('button',{name:'編輯 Synthetic trial invitation',exact:true}).isDisabled(),true);
    assert.equal(await row.getByRole('button',{name:'重發邀請',exact:true}).isEnabled(),true);
    const facts=(await input.client.query(`SELECT t.level,t.categories,p.employment_type,u.status
      FROM identity_users u JOIN access_trial_members t ON t.user_id=u.id
      JOIN access_employee_profiles p ON p.membership_id=t.membership_id WHERE u.normalized_email=$1`,[email])).rows;
    assert.deepEqual(facts,[{level:'l2',categories:['international_school','local_school'],employment_type:'PART_TIME',status:'invited'}]);
    const invite=(await input.client.query('SELECT i.id,i.record_version FROM identity_invites i JOIN identity_users u ON u.id=i.target_user_id WHERE u.normalized_email=$1',[email])).rows[0];
    const resendKeys:string[]=[];
    await page.route('**/api/v1/auth/invites/*/resend',async route=>{
      resendKeys.push(route.request().headers()['idempotency-key']!);
      const result=await route.fetch();assert.equal(result.status(),200);
      if(resendKeys.length===1) await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'SERVICE_UNAVAILABLE',message:'Synthetic lost acknowledgement',request_id:'synthetic-resend'}})});
      else await route.fulfill({response:result});
    });
    await row.getByRole('button',{name:'重發邀請',exact:true}).click();
    await row.getByRole('button',{name:'確認重發結果',exact:true}).click();
    await page.getByText('邀請郵件已重新發送；先前的確認連結已失效。',{exact:true}).waitFor();
    assert.equal(resendKeys.length,2);assert.equal(resendKeys[0],resendKeys[1]);
    assert.equal(Number((await input.client.query('SELECT record_version FROM identity_invites WHERE id=$1',[invite.id])).rows[0].record_version),Number(invite.record_version)+1);
    // A rejected reload must also remove stale invitation controls and employee data.
    await page.route('**/api/v1/auth/users',async route=>route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({error:{code:'FORBIDDEN',message:'Synthetic denied',request_id:'synthetic-denial'}})}));
    await page.getByRole('button',{name:'重新載入',exact:true}).click();
    await page.getByText('無法查看使用者',{exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'邀請使用者',exact:true}).count(),0);
    assert.equal(await page.getByText(email,{exact:true}).count(),0);
    process.stdout.write(JSON.stringify({trial_invite_browser:'pass',level:'l2',categories:2,employment:'PART_TIME',mobile:390,denied_reload:'cleared'})+'\n');
  }finally{await context.close();}
}
