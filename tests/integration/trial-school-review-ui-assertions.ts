import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {APIRequestContext,Page} from 'playwright-core';

export async function assertTrialSchoolReviewUi(input:{page:Page;l2Page:Page;founder:APIRequestContext;baseUrl:string;schoolId:string}){
  const {page,l2Page,founder,baseUrl,schoolId}=input;
  const detail=`${baseUrl}/schools/${schoolId}`,resolved=`${baseUrl}/api/v1/schools/${schoolId}/resolved`;
  async function candidate(label:string){
    const current=(await (await founder.get(resolved)).json()).data;
    const response=await founder.post(`${baseUrl}/api/v1/schools/${schoolId}/change-requests`,{headers:{'idempotency-key':randomUUID()},data:{field_name:'phone',field_class:'general',base_snapshot_id:current.base_snapshot_id,
      base_value_sha256:current.change_context.base_value_hashes.phone??current.change_context.empty_value_sha256,
      expected_effective_value_sha256:current.change_context.effective_value_hashes.phone??current.change_context.empty_value_sha256,
      proposed_value:label,reason:'Synthetic UI review',evidence:{source_url:'https://example.invalid/school',quote:'Synthetic review evidence'}}});
    assert.equal(response.status(),200);return (await response.json()).data.change_request_id as string;
  }
  const pending=()=>page.getByRole('region',{name:'待處理更新',exact:true});
  const row=(label:string)=>pending().getByRole('listitem').filter({has:page.getByText(`申請值：${label}`,{exact:true})});
  const form=()=>page.getByRole('form',{name:/人工變更 #\d+ 審批/});
  async function confirm(reason:string){await form().getByLabel('審批理由',{exact:true}).fill(reason);await form().getByRole('checkbox').check();}
  await candidate('UI rejected phone');
  await page.goto(detail);
  await row('UI rejected phone').getByRole('button',{name:'拒絕申請',exact:true}).click();
  await form().getByRole('button',{name:'確認拒絕',exact:true}).click();
  await form().getByText('請填寫審批理由並確認已核對資料。',{exact:true}).waitFor();
  await confirm('Synthetic UI rejection');
  await form().getByRole('button',{name:'確認拒絕',exact:true}).click();
  const history=page.getByRole('region',{name:'更新履歷',exact:true});
  await history.getByText('審批理由：Synthetic UI rejection',{exact:true}).waitFor();
  assert.equal((await (await founder.get(resolved)).json()).data.fields.phone,'Synthetic L1-approved phone');
  const approvedId=await candidate('UI approved phone');
  await page.reload();
  await row('UI approved phone').getByRole('button',{name:'批准申請',exact:true}).click();
  await confirm('Synthetic UI approval');
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
  await row('UI approved phone').screenshot({path:'/tmp/access-trial-school-review-ui-mobile.png'});
  const reviewUrl=`${baseUrl}/api/v1/admin/schools/change-requests/${approvedId}/reviews`;
  let key:string|undefined;
  await page.route(reviewUrl,async route=>{
    if(key){await route.continue();return}
    key=route.request().headers()['idempotency-key'];
    const committed=await route.fetch();assert.equal(committed.status(),200);
    await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({api_version:'v1',request_id:'lost-review-ack',error:{code:'SERVICE_UNAVAILABLE',message:'Retry',retryable:true}})});
  });
  await form().getByRole('button',{name:'確認批准',exact:true}).click();
  await form().getByText('尚未確認審批結果。請重試原決定，避免重複處理。',{exact:true}).waitFor();
  assert.equal(await form().getByLabel('審批理由',{exact:true}).isDisabled(),true);
  assert.equal(await page.getByRole('button',{name:'重新載入學校資料',exact:true}).isDisabled(),true);
  const retry=page.waitForResponse(response=>response.url()===reviewUrl&&response.status()===200);
  await form().getByRole('button',{name:'重試原決定',exact:true}).click();
  assert.equal((await retry).request().headers()['idempotency-key'],key);
  await history.getByText('審批理由：Synthetic UI approval',{exact:true}).waitFor();
  assert.equal(await history.getByText('審批理由：Synthetic UI approval',{exact:true}).count(),1);
  await page.unroute(reviewUrl);
  await page.reload();
  await history.getByText('審批理由：Synthetic UI approval',{exact:true}).waitFor();
  await page.getByRole('region',{name:'基礎資料',exact:true}).getByText('UI approved phone',{exact:true}).waitFor();
  const approvedRow=history.getByRole('listitem').filter({has:page.getByText('審批理由：Synthetic UI approval',{exact:true})});
  await approvedRow.getByText('提交時有效值：Synthetic L1-approved phone',{exact:true}).waitFor();
  assert.match(await approvedRow.innerText(),/審批人：.+ · L1/);
  await l2Page.goto(detail);await l2Page.getByRole('heading',{name:'待處理更新',exact:true}).waitFor();
  assert.equal(await l2Page.getByRole('button',{name:/批准申請|拒絕申請/}).count(),0);
  const staleId=await candidate('UI stale phone'),competingId=await candidate('UI competing phone');
  await page.reload();
  await row('UI stale phone').getByRole('button',{name:'批准申請',exact:true}).click();
  await confirm('Stale decision must not apply');
  assert.equal((await page.request.post(`${baseUrl}/api/v1/admin/schools/change-requests/${competingId}/reviews`,{headers:{'idempotency-key':randomUUID()},data:{decision:'approve',expected_record_version:1,reason:'Concurrent colleague decision'}})).status(),200);
  const staleUrl=`${baseUrl}/api/v1/admin/schools/change-requests/${staleId}/reviews`;
  let lostStaleResponse=false;
  await page.route(staleUrl,async route=>{
    if(lostStaleResponse){await route.continue();return}
    lostStaleResponse=true;
    const conflict=await route.fetch();assert.equal(conflict.status(),409);
    await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({api_version:'v1',request_id:'lost-conflict',error:{code:'SERVICE_UNAVAILABLE',message:'Retry',retryable:true}})});
  });
  await form().getByRole('button',{name:'確認批准',exact:true}).click();
  await form().getByText('尚未確認審批結果。請重試原決定，避免重複處理。',{exact:true}).waitFor();
  await form().getByRole('button',{name:'重試原決定',exact:true}).click();
  await form().getByText('資料或審批狀態已變更，請重新載入並核對；原確認不再適用。',{exact:true}).waitFor();
  assert.equal(await form().getByRole('button',{name:'確認批准',exact:true}).isDisabled(),true);
  await form().getByRole('button',{name:'關閉並重新載入',exact:true}).click();
  await row('UI stale phone').getByText('資料已變更，此申請不能再批准；可拒絕並請同事重新核對提交。',{exact:true}).waitFor();
  assert.equal(await row('UI stale phone').getByRole('button',{name:'批准申請',exact:true}).count(),0);
  await row('UI stale phone').getByRole('button',{name:'拒絕申請',exact:true}).click();
  assert.equal(await form().getByRole('checkbox').isChecked(),false);
  await confirm('Reject stale application');
  await page.unroute(staleUrl);
  await page.route(staleUrl,route=>route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({api_version:'v1',request_id:'denied-review',error:{code:'FORBIDDEN',message:'Denied',retryable:false}})}));
  await form().getByRole('button',{name:'確認拒絕',exact:true}).click();
  await page.getByText('登入狀態或學校存取權限已變更，請重新登入或聯絡管理員。',{exact:true}).waitFor();
  assert.equal(await pending().count(),0);
  await page.unroute(staleUrl);
  process.stdout.write(JSON.stringify({trial_school_review_ui:'pass',decisions:'approve_reject',lost_ack:'same_key',history:'actor_reason_old_value',stale:'reload_new_confirmation',l2:'no_actions',denied:'cleared',viewport:390})+'\n');
}
